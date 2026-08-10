"""api-catalog → api-collections 1회 마이그레이션.

- 부서 디렉토리 → workspace. 그 안의 Bruno 콜렉션 디렉토리(bruno.json) 또는
  *.postman_collection.json → 콜렉션 문서.
- environments/*.bru, *.postman_environment.json → 파일명(stem)이 같은 부서의
  콜렉션에 환경으로 부착 (없으면 첫 콜렉션).
- 워크플로우 파일의 catalogEntry 참조와 sourceApiId/lookupApiId를 새 참조 체계
  (department=workspace, collectionFile=콜렉션 id)로 재작성.

실행: server/ 디렉토리에서  python -m scripts.migrate_catalog_to_collections
      (기본 dry-run. 실제 적용은 --apply)
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from app import bruno
from app import collections as store
from app.catalog import entry_id
from app.config import DATA_DIR, WORKFLOWS_DIR

CATALOG_DIR = DATA_DIR / "api-catalog"

RefMap = dict[tuple[str, str, tuple[str, ...], str], dict[str, Any]]


def _load_sources(dept_dir: Path) -> list[tuple[str, dict[str, Any]]]:
    """부서 디렉토리 → [(구 collectionFile, 콜렉션 문서)] 목록."""
    if (dept_dir / "bruno.json").exists():
        # Bruno 콜렉션 디렉토리 — 구 collectionFile은 디렉토리명
        return [(dept_dir.name, store._bruno_dir_to_doc(dept_dir))]
    out = []
    for path in sorted(dept_dir.glob("**/*.postman_collection.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append((path.name, store._from_postman(data)))
    return out


def _load_environments() -> list[tuple[str, dict[str, str]]]:
    """environments/ 디렉토리 → [(이름, 변수맵)]."""
    env_dir = CATALOG_DIR / "environments"
    out: list[tuple[str, dict[str, str]]] = []
    if not env_dir.is_dir():
        return out
    for path in sorted(env_dir.iterdir()):
        try:
            if path.suffix == ".bru":
                out.append((path.stem, bruno.parse_environment(path.read_text(encoding="utf-8"))))
            elif path.name.endswith(".postman_environment.json"):
                data = json.loads(path.read_text(encoding="utf-8"))
                values = {
                    v["key"]: v.get("value", "")
                    for v in data.get("values", [])
                    if v.get("enabled", True) and "key" in v
                }
                name = path.name.removesuffix(".postman_environment.json")
                out.append((name, values))
        except (OSError, json.JSONDecodeError):
            continue
    return out


def _walk_refs(
    items: list[Any],
    *,
    dept: str,
    old_file: str,
    new_cid: str,
    trail: tuple[str, ...],
    exact: RefMap,
    loose: dict[tuple[str, tuple[str, ...], str], dict[str, Any]],
    id_map: dict[str, str],
) -> None:
    for item in items:
        if item.get("type") == "folder":
            _walk_refs(
                item.get("items") or [],
                dept=dept, old_file=old_file, new_cid=new_cid,
                trail=(*trail, item["name"]), exact=exact, loose=loose, id_map=id_map,
            )
            continue
        if item.get("type") != "http":
            continue
        name = item["name"]
        new_ref = {
            "department": dept,
            "collectionFile": new_cid,
            "itemPath": list(trail),
            "name": name,
        }
        exact[(dept, old_file, trail, name)] = new_ref
        # 구 collectionFile이 어긋난 낡은 참조(파일명 변경 등)를 위한 느슨한 키
        loose.setdefault((dept, trail, name), new_ref)
        id_map[entry_id(dept, old_file, list(trail), name)] = entry_id(
            dept, new_cid, list(trail), name
        )


def _rewrite(obj: Any, exact: RefMap, loose: dict, id_map: dict[str, str], stats: dict) -> Any:
    if isinstance(obj, dict):
        keys = set(obj)
        if {"department", "collectionFile", "itemPath", "name"} <= keys:
            key = (obj["department"], obj["collectionFile"], tuple(obj["itemPath"]), obj["name"])
            new_ref = exact.get(key) or loose.get((obj["department"], tuple(obj["itemPath"]), obj["name"]))
            if new_ref:
                stats["refs"] += 1
                return dict(new_ref)
            stats["unresolved_refs"].append(key)
            return obj
        out = {}
        for k, v in obj.items():
            if k in ("sourceApiId", "lookupApiId") and isinstance(v, str):
                if v in id_map:
                    stats["ids"] += 1
                    out[k] = id_map[v]
                else:
                    stats["unresolved_ids"].add(v)
                    out[k] = v
            else:
                out[k] = _rewrite(v, exact, loose, id_map, stats)
        return out
    if isinstance(obj, list):
        return [_rewrite(v, exact, loose, id_map, stats) for v in obj]
    return obj


def main(apply: bool) -> None:
    if not CATALOG_DIR.is_dir():
        print(f"api-catalog 디렉토리가 없습니다: {CATALOG_DIR}")
        sys.exit(1)

    exact: RefMap = {}
    loose: dict = {}
    id_map: dict[str, str] = {}
    plans: list[tuple[str, str, dict[str, Any]]] = []  # (workspace, old_file, doc)

    dept_dirs = [
        d for d in sorted(CATALOG_DIR.iterdir())
        if d.is_dir() and d.name not in ("environments",) and not d.name.startswith(".")
    ]
    for dept_dir in dept_dirs:
        for old_file, doc in _load_sources(dept_dir):
            doc["id"] = store._new_id()
            plans.append((dept_dir.name, old_file, doc))
            _walk_refs(
                doc["items"], dept=dept_dir.name, old_file=old_file, new_cid=doc["id"],
                trail=(), exact=exact, loose=loose, id_map=id_map,
            )

    # 환경 부착: stem이 부서명과 같으면 그 부서의 첫 콜렉션, 아니면 전체 첫 콜렉션
    envs = _load_environments()
    for env_name, values in envs:
        target = next((p for p in plans if p[0] == env_name), plans[0] if plans else None)
        if target is None:
            continue
        doc = target[2]
        doc.setdefault("environments", []).append(
            {
                "name": env_name,
                "variables": [
                    {"name": k, "value": v, "enabled": True} for k, v in values.items()
                ],
            }
        )
        if not doc.get("activeEnvironment"):
            doc["activeEnvironment"] = env_name

    print(f"콜렉션 {len(plans)}개 생성 예정:")
    for ws, old_file, doc in plans:
        n_env = len(doc.get("environments") or [])
        print(f"  workspace={ws}  '{doc['name']}' (구 {old_file}) → id={doc['id']}, 환경 {n_env}개")

    # 워크플로우 재작성
    stats = {"refs": 0, "ids": 0, "unresolved_refs": [], "unresolved_ids": set()}
    rewrites: list[tuple[Path, dict]] = []
    for path in sorted(WORKFLOWS_DIR.glob("*/*/*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        new_data = _rewrite(data, exact, loose, id_map, stats)
        if new_data != data:
            rewrites.append((path, new_data))
    print(f"워크플로우 참조 재작성: {len(rewrites)}개 파일, catalogEntry {stats['refs']}건, apiId {stats['ids']}건")
    if stats["unresolved_refs"]:
        print("  ⚠ 미해결 참조:", stats["unresolved_refs"])
    if stats["unresolved_ids"]:
        print("  ⚠ 미해결 apiId:", stats["unresolved_ids"])

    if not apply:
        print("\n(dry-run — 적용하려면 --apply)")
        return

    for ws, _, doc in plans:
        try:
            store.create_workspace(ws)
        except ValueError:
            pass  # 이미 존재
        store.save_collection(ws, doc)
    for path, new_data in rewrites:
        path.write_text(json.dumps(new_data, ensure_ascii=False, indent=2), encoding="utf-8")
    print("적용 완료. api-catalog 디렉토리는 확인 후 수동으로 삭제하세요.")


if __name__ == "__main__":
    main(apply="--apply" in sys.argv)
