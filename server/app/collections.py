"""API 콜렉션 — Bruno 스타일 workspace/collection 저장소 + Import/Export 변환.

저장 구조: `data/api-collections/{workspace}/{collection_id}.json`
  - workspace = 디렉토리, collection = 트리(폴더/요청/환경) 전체를 담은 JSON 문서 1개.
  - 문서 형태는 Bruno 콜렉션 export JSON에 맞춘다(items[].type = "folder"|"http").

Import는 Bruno 콜렉션 JSON과 Postman Collection v2.1을 자동 감지해 내부 형태로
정규화하고, Export는 두 형식 모두로 변환해 내려준다.
"""
from __future__ import annotations

import asyncio
import io
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
import uuid
from pathlib import Path
from typing import Any

import httpx

from . import bruno, storage

# 데이터 소스: prod(운영 master 트리, 읽기 전용) | edit(브랜치별 편집 worktree).
# 워크플로우와 동일한 브랜치 편집 플로우 — 쓰기는 편집 worktree에서만 허용된다.
def _dir(source: str = "prod", branch: str | None = None):
    return storage.data_root(source, branch) / "api-collections"


# 경로 traversal 방지 — storage와 동일한 규칙(유니코드 단어문자 + 하이픈).
_SAFE_SEGMENT = re.compile(r"^[-\w]+$", re.UNICODE)

# workspace 이름은 사용자가 입력하므로 공백도 허용한다(선두/말미 공백은 제거).
_SAFE_NAME = re.compile(r"^[-\w ]+$", re.UNICODE)


def _safe_ws(name: str) -> str:
    name = name.strip()
    if not name or not _SAFE_NAME.match(name):
        raise ValueError(f"허용되지 않는 workspace 이름입니다: {name!r}")
    return name


def _safe_id(collection_id: str) -> str:
    if not collection_id or not _SAFE_SEGMENT.match(collection_id):
        raise ValueError(f"허용되지 않는 콜렉션 id입니다: {collection_id!r}")
    return collection_id


def _new_id() -> str:
    return uuid.uuid4().hex[:16]


# ---------------------------------------------------------------------------
# Workspace CRUD
# ---------------------------------------------------------------------------
def list_workspaces(source: str = "prod", branch: str | None = None) -> list[dict[str, Any]]:
    root = _dir(source, branch)
    if not root.exists():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if not d.is_dir():
            continue
        out.append({"name": d.name, "collection_count": len(list(d.glob("*.json")))})
    return out


def create_workspace(name: str, source: str = "prod", branch: str | None = None) -> None:
    path = _dir(source, branch) / _safe_ws(name)
    if path.exists():
        raise ValueError(f"이미 존재하는 workspace입니다: {name!r}")
    path.mkdir(parents=True)


def delete_workspace(name: str, source: str = "prod", branch: str | None = None) -> bool:
    path = _dir(source, branch) / _safe_ws(name)
    if not path.is_dir():
        return False
    shutil.rmtree(path)
    return True


# ---------------------------------------------------------------------------
# Collection CRUD — 문서 전체를 통째로 저장/로드 (프론트가 트리를 편집)
# ---------------------------------------------------------------------------
def _count_requests(items: list[Any]) -> int:
    n = 0
    for item in items:
        if not isinstance(item, dict):
            continue
        if item.get("type") == "folder":
            n += _count_requests(item.get("items") or [])
        elif item.get("type") == "http":
            n += 1
    return n


def list_collections(workspace: str, source: str = "prod", branch: str | None = None) -> list[dict[str, Any]]:
    ws_dir = _dir(source, branch) / _safe_ws(workspace)
    if not ws_dir.is_dir():
        raise ValueError(f"존재하지 않는 workspace입니다: {workspace!r}")
    out = []
    for path in sorted(ws_dir.glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        out.append(
            {
                "id": doc.get("id", path.stem),
                "name": doc.get("name", path.stem),
                "request_count": _count_requests(doc.get("items") or []),
            }
        )
    out.sort(key=lambda c: c["name"])
    return out


def _validate_doc(doc: dict[str, Any]) -> None:
    if not isinstance(doc.get("id"), str) or not doc["id"]:
        raise ValueError("콜렉션 문서에 id가 없습니다")
    if not isinstance(doc.get("name"), str) or not doc["name"].strip():
        raise ValueError("콜렉션 문서에 name이 없습니다")
    if not isinstance(doc.get("items"), list):
        raise ValueError("콜렉션 문서의 items는 배열이어야 합니다")


def save_collection(workspace: str, doc: dict[str, Any], source: str = "prod", branch: str | None = None) -> None:
    _validate_doc(doc)
    ws_dir = _dir(source, branch) / _safe_ws(workspace)
    if not ws_dir.is_dir():
        raise ValueError(f"존재하지 않는 workspace입니다: {workspace!r}")
    path = ws_dir / f"{_safe_id(doc['id'])}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)  # 원자적 교체


def create_collection(workspace: str, name: str, source: str = "prod", branch: str | None = None) -> dict[str, Any]:
    name = name.strip()
    if not name:
        raise ValueError("콜렉션 이름이 비어있습니다")
    doc = {
        "id": _new_id(),
        "name": name,
        "items": [],
        "environments": [],
        "activeEnvironment": None,
    }
    save_collection(workspace, doc, source, branch)
    return doc


def load_collection(
    workspace: str, collection_id: str, source: str = "prod", branch: str | None = None
) -> dict[str, Any] | None:
    path = _dir(source, branch) / _safe_ws(workspace) / f"{_safe_id(collection_id)}.json"
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf-8"))


def delete_collection(
    workspace: str, collection_id: str, source: str = "prod", branch: str | None = None
) -> bool:
    path = _dir(source, branch) / _safe_ws(workspace) / f"{_safe_id(collection_id)}.json"
    if not path.exists():
        return False
    path.unlink()
    return True


# ---------------------------------------------------------------------------
# Import — Bruno 콜렉션 JSON / Postman Collection v2.1 자동 감지
# ---------------------------------------------------------------------------
def import_collection(
    workspace: str, data: dict[str, Any], source: str = "prod", branch: str | None = None
) -> dict[str, Any]:
    if not isinstance(data, dict):
        raise ValueError("콜렉션 JSON 객체가 아닙니다")
    if isinstance(data.get("info"), dict) and "item" in data:
        doc = _from_postman(data)
    elif "items" in data and "name" in data:
        doc = _from_bruno(data)
    else:
        raise ValueError("지원하지 않는 형식입니다 (Bruno 콜렉션 JSON 또는 Postman v2.1)")
    doc["id"] = _new_id()
    save_collection(workspace, doc, source, branch)
    return doc


def _kv(
    name: Any, value: Any, enabled: bool = True, description: Any = None
) -> dict[str, Any]:
    out = {"name": str(name or ""), "value": str(value or ""), "enabled": bool(enabled)}
    if description:
        out["description"] = _desc_text(description)
    return out


def _desc_text(description: Any) -> str:
    """Postman description은 문자열 또는 {content, type} 객체 — 문자열로 정규화."""
    if isinstance(description, dict):
        return str(description.get("content") or "")
    return str(description)


def _normalize_output(raw: Any) -> list[Any]:
    """output 필드 정규화 — 문자열(이름만) 또는 {name, label}(한글 설명 포함) 혼합 목록."""
    if not isinstance(raw, list):
        return []
    out: list[Any] = []
    for f in raw:
        if isinstance(f, dict) and f.get("name"):
            item = {"name": str(f["name"])}
            if f.get("label"):
                item["label"] = str(f["label"])
            out.append(item if "label" in item else item["name"])
        elif isinstance(f, str) and f:
            out.append(f)
    return out


def _normalize_body(body: Any) -> dict[str, Any]:
    """Bruno request.body → 내부 지원 모드(none/json/text)로 축소."""
    if not isinstance(body, dict):
        return {"mode": "none"}
    mode = body.get("mode")
    if mode == "json":
        return {"mode": "json", "json": str(body.get("json") or "")}
    if mode in ("text", "xml", "sparql"):
        return {"mode": "text", "text": str(body.get(mode) or body.get("text") or "")}
    return {"mode": "none"}


def _from_bruno(data: dict[str, Any]) -> dict[str, Any]:
    def walk(items: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            typ = item.get("type")
            if typ == "folder":
                out.append(
                    {
                        "type": "folder",
                        "name": str(item.get("name") or "폴더"),
                        "items": walk(item.get("items")),
                    }
                )
                continue
            if typ not in ("http", "http-request"):
                continue  # graphql/grpc 등은 스코프 밖
            req = item.get("request") if isinstance(item.get("request"), dict) else {}
            converted: dict[str, Any] = {
                "type": "http",
                "name": str(item.get("name") or "요청"),
                "request": {
                    "method": str(req.get("method") or "GET").upper(),
                    "url": str(req.get("url") or ""),
                    "headers": [
                        _kv(h.get("name"), h.get("value"), h.get("enabled", True), h.get("description"))
                        for h in req.get("headers") or []
                        if isinstance(h, dict)
                    ],
                    "params": [
                        {**_kv(p.get("name"), p.get("value"), p.get("enabled", True), p.get("description")),
                         "kind": "path" if p.get("type") == "path" else "query"}
                        for p in req.get("params") or []
                        if isinstance(p, dict)
                    ],
                    "body": _normalize_body(req.get("body")),
                },
            }
            if isinstance(req.get("output"), list):  # flowwork 확장 필드 (응답 명세)
                converted["request"]["output"] = _normalize_output(req["output"])
            out.append(converted)
        return out

    environments = []
    for env in data.get("environments") or []:
        if not isinstance(env, dict):
            continue
        environments.append(
            {
                "name": str(env.get("name") or "env"),
                "variables": [
                    _kv(v.get("name"), v.get("value"), v.get("enabled", True))
                    for v in env.get("variables") or []
                    if isinstance(v, dict)
                ],
            }
        )
    return {
        "id": "",
        "name": str(data.get("name") or "가져온 콜렉션"),
        "items": walk(data.get("items")),
        "environments": environments,
        "activeEnvironment": environments[0]["name"] if environments else None,
    }


def _postman_url(url: Any) -> str:
    if isinstance(url, str):
        return url
    if isinstance(url, dict):
        return str(url.get("raw") or "")
    return ""


def _postman_body(body: Any) -> dict[str, Any]:
    if not isinstance(body, dict):
        return {"mode": "none"}
    if body.get("mode") == "raw":
        raw = str(body.get("raw") or "")
        try:
            json.loads(raw)
            return {"mode": "json", "json": raw}
        except (json.JSONDecodeError, TypeError):
            return {"mode": "text", "text": raw}
    if body.get("mode") == "urlencoded":
        pairs = [
            f"{p.get('key', '')}={p.get('value', '')}"
            for p in body.get("urlencoded") or []
            if isinstance(p, dict) and not p.get("disabled")
        ]
        return {"mode": "text", "text": "&".join(pairs)}
    return {"mode": "none"}


def _from_postman(data: dict[str, Any]) -> dict[str, Any]:
    def walk(items: Any) -> list[dict[str, Any]]:
        out: list[dict[str, Any]] = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("item"), list):  # 폴더
                out.append(
                    {
                        "type": "folder",
                        "name": str(item.get("name") or "폴더"),
                        "items": walk(item["item"]),
                    }
                )
                continue
            req = item.get("request")
            if not isinstance(req, dict):
                continue
            converted: dict[str, Any] = {
                "type": "http",
                "name": str(item.get("name") or "요청"),
                "request": {
                    "method": str(req.get("method") or "GET").upper(),
                    "url": _postman_url(req.get("url")),
                    "headers": [
                        _kv(h.get("key"), h.get("value"), not h.get("disabled"), h.get("description"))
                        for h in req.get("header") or []
                        if isinstance(h, dict)
                    ],
                    "params": [],  # 쿼리는 url.raw에 이미 포함되어 있다
                    "body": _postman_body(req.get("body")),
                },
            }
            if isinstance(item.get("_output"), list):  # flowwork 확장 (응답 명세)
                converted["request"]["output"] = _normalize_output(item["_output"])
            out.append(converted)
        return out

    # 콜렉션 변수(variable[])는 환경 하나로 승격해 가져온다
    environments = []
    coll_vars = [
        _kv(v.get("key"), v.get("value"))
        for v in data.get("variable") or []
        if isinstance(v, dict) and v.get("key")
    ]
    if coll_vars:
        environments.append({"name": "collection-vars", "variables": coll_vars})
    return {
        "id": "",
        "name": str(data["info"].get("name") or "가져온 콜렉션"),
        "items": walk(data.get("item")),
        "environments": environments,
        "activeEnvironment": environments[0]["name"] if environments else None,
    }


# ---------------------------------------------------------------------------
# Import — GitHub 레포 (Bruno 콜렉션 디렉토리 / Postman·Bruno JSON 파일)
# ---------------------------------------------------------------------------
# github.com 레포 URL만 허용한다 (SSRF 방지 — 실제 다운로드는 codeload.github.com).
_GITHUB_URL = re.compile(
    r"^https://github\.com/(?P<owner>[\w.-]+)/(?P<repo>[\w.-]+?)(?:\.git)?"
    r"(?:/tree/(?P<branch>[^/]+)(?:/(?P<subpath>.*))?)?/?$"
)

# 압축 해제 안전 한도 (zip-bomb 방지)
_MAX_EXTRACT_BYTES = 50 * 1024 * 1024
_MAX_EXTRACT_FILES = 2000


def parse_github_url(url: str) -> tuple[str, str, str | None, str | None]:
    """GitHub URL → (owner, repo, branch, subpath). /tree/{branch}/{하위경로}도 지원."""
    m = _GITHUB_URL.match(url.strip())
    if not m:
        raise ValueError("github.com 레포 URL이 아닙니다 (예: https://github.com/owner/repo)")
    return m["owner"], m["repo"], m["branch"], m["subpath"]


def get_github_token() -> str | None:
    """GitHub 토큰 — env(FLOWWORK_GITHUB_TOKEN/GITHUB_TOKEN) → gh CLI(`gh auth token`) 순.

    서버는 로컬에서 돌므로, 사용자가 터미널에서 `gh auth login` 해두면 그 인증을
    그대로 사용한다. 토큰은 응답/로그에 노출하지 않는다.
    """
    for key in ("FLOWWORK_GITHUB_TOKEN", "GITHUB_TOKEN"):
        token = os.environ.get(key, "").strip()
        if token:
            return token
    try:
        proc = subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, timeout=5
        )
    except (OSError, subprocess.TimeoutExpired):
        return None
    token = proc.stdout.strip()
    return token if proc.returncode == 0 and token else None


async def github_auth_status() -> dict[str, Any]:
    """로그인 상태 + 사용자명(login). 토큰 자체는 절대 반환하지 않는다."""
    token = await asyncio.to_thread(get_github_token)
    if not token:
        return {"logged_in": False, "login": None}
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(
                "https://api.github.com/user",
                headers={"Authorization": f"Bearer {token}"},
            )
        except httpx.RequestError:
            # 네트워크 실패 — 토큰은 있으므로 로그인 상태로 취급
            return {"logged_in": True, "login": None}
    if resp.status_code == 200:
        return {"logged_in": True, "login": resp.json().get("login")}
    return {"logged_in": False, "login": None}  # 토큰 만료/무효


async def _default_branch(
    client: httpx.AsyncClient, owner: str, repo: str, headers: dict[str, str]
) -> str | None:
    try:
        resp = await client.get(f"https://api.github.com/repos/{owner}/{repo}", headers=headers)
    except httpx.RequestError:
        return None
    if resp.status_code == 200:
        return resp.json().get("default_branch")
    return None


async def _fetch_tarball(owner: str, repo: str, branch: str | None) -> bytes:
    """레포 tar.gz 다운로드.

    토큰이 있으면 api.github.com/tarball(공개+private, 인증 헤더)을, 없으면
    codeload(공개 전용)를 쓴다. 브랜치 미지정 시 기본 브랜치 조회 → main/master 순.
    """
    token = await asyncio.to_thread(get_github_token)
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        if branch:
            branches = [branch]
        else:
            default = await _default_branch(client, owner, repo, headers)
            branches = [default] if default else ["main", "master"]
        for b in branches:
            url = (
                f"https://api.github.com/repos/{owner}/{repo}/tarball/{b}"
                if token
                else f"https://codeload.github.com/{owner}/{repo}/tar.gz/refs/heads/{b}"
            )
            try:
                resp = await client.get(url, headers=headers)
            except httpx.RequestError as e:
                raise ValueError(f"GitHub 다운로드 실패: {e}") from e
            if resp.status_code == 200:
                return resp.content
    hint = (
        " (브랜치 확인)"
        if token
        else " — private 레포라면 터미널에서 `gh auth login` 후 다시 시도하세요"
    )
    raise ValueError(f"레포를 찾을 수 없습니다: {owner}/{repo}{hint}")


def _safe_extract(tar_bytes: bytes, dest: Path) -> None:
    """tar 안전 해제 — 경로 탈출/심볼릭 링크 차단, 파일 수·총량 제한."""
    total = 0
    count = 0
    with tarfile.open(fileobj=io.BytesIO(tar_bytes), mode="r:gz") as tf:
        for member in tf:
            if not (member.isfile() or member.isdir()):
                continue  # symlink/device 등 무시
            target = (dest / member.name).resolve()
            if not target.is_relative_to(dest.resolve()):
                continue  # 경로 탈출 시도 무시
            count += 1
            total += member.size
            if count > _MAX_EXTRACT_FILES or total > _MAX_EXTRACT_BYTES:
                raise ValueError("레포가 너무 큽니다 (파일 수/용량 제한 초과)")
            tf.extract(member, dest, filter="data")


def _bru_body(parsed: dict[str, Any]) -> dict[str, Any]:
    """parse_request 결과의 (bodyMode, raw) → 내부 body."""
    raw = (parsed["request"].get("body") or {}).get("raw")
    if raw is None:
        return {"mode": "none"}
    mode = parsed.get("bodyMode")
    if mode == "json":
        return {"mode": "json", "json": raw}
    return {"mode": "text", "text": raw}


def _bru_file_to_item(path: Path) -> dict[str, Any] | None:
    try:
        parsed = bruno.parse_request(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    name = parsed["name"] or path.stem
    request = parsed["request"]
    url = request["url"]["raw"] if isinstance(request["url"], dict) else request["url"]
    item: dict[str, Any] = {
        "type": "http",
        "name": name,
        "_seq": parsed["seq"],  # 정렬용 (반환 전 제거)
        "request": {
            "method": request.get("method", "GET"),
            "url": url,
            "headers": [
                _kv(h.get("key"), h.get("value"), True, h.get("description"))
                for h in request.get("header") or []
            ],
            "params": [],  # .bru의 쿼리는 url에 이미 포함
            "body": _bru_body(parsed),
        },
    }
    # docs 블록의 output(응답 필드 명세, `이름=라벨` 한글 설명 지원)
    if parsed["output"]:
        item["request"]["output"] = _normalize_output(parsed["output"])
    return item


def _bruno_dir_items(directory: Path) -> list[dict[str, Any]]:
    """Bruno 콜렉션 디렉토리를 재귀 순회 — 하위 디렉토리=폴더, .bru=요청."""
    items: list[dict[str, Any]] = []
    for child in sorted(directory.iterdir()):
        if child.name.startswith(".") or child.name in ("environments", "node_modules"):
            continue
        if child.is_dir():
            sub = _bruno_dir_items(child)
            if sub:
                items.append({"type": "folder", "name": child.name, "items": sub})
        elif child.suffix == ".bru" and child.name != "folder.bru":
            item = _bru_file_to_item(child)
            if item:
                items.append(item)
    # 같은 레벨에서는 폴더 먼저, 요청은 seq 순
    folders = [i for i in items if i["type"] == "folder"]
    requests = sorted((i for i in items if i["type"] == "http"), key=lambda i: i["_seq"])
    for r in requests:
        del r["_seq"]
    return [*folders, *requests]


def _bruno_dir_to_doc(directory: Path) -> dict[str, Any]:
    try:
        manifest = json.loads((directory / "bruno.json").read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        manifest = {}
    environments = []
    env_dir = directory / "environments"
    if env_dir.is_dir():
        for env_file in sorted(env_dir.glob("*.bru")):
            try:
                values = bruno.parse_environment(env_file.read_text(encoding="utf-8"))
            except OSError:
                continue
            environments.append(
                {
                    "name": env_file.stem,
                    "variables": [_kv(k, v) for k, v in values.items()],
                }
            )
    return {
        "id": "",
        "name": str(manifest.get("name") or directory.name),
        "items": _bruno_dir_items(directory),
        "environments": environments,
        "activeEnvironment": environments[0]["name"] if environments else None,
    }


def scan_directory(root: Path) -> list[dict[str, Any]]:
    """디렉토리에서 콜렉션들을 찾는다.

    - bruno.json이 있는 디렉토리 → Bruno 콜렉션 (하위는 재탐색 안 함)
    - *.postman_collection.json → Postman 콜렉션
    - {name, items}를 가진 기타 *.json → Bruno export JSON
    """
    docs: list[dict[str, Any]] = []

    def walk(directory: Path) -> None:
        if (directory / "bruno.json").exists():
            docs.append(_bruno_dir_to_doc(directory))
            return
        for child in sorted(directory.iterdir()):
            if child.name.startswith(".") or child.name == "node_modules":
                continue
            if child.is_dir():
                walk(child)
                continue
            if child.suffix != ".json" or child.name == "bruno.json":
                continue
            try:
                data = json.loads(child.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(data, dict):
                continue
            if child.name.endswith(".postman_collection.json"):
                docs.append(_from_postman(data))
            elif "items" in data and "name" in data:
                docs.append(_from_bruno(data))

    walk(root)
    return docs


async def _fetch_repo_docs(url: str) -> list[dict[str, Any]]:
    """GitHub 레포를 받아 콜렉션 문서 목록으로 변환한다."""
    owner, repo, branch, subpath = parse_github_url(url)
    tar_bytes = await _fetch_tarball(owner, repo, branch)
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp)
        _safe_extract(tar_bytes, dest)
        # tarball 루트는 {repo}-{branch}/ 단일 디렉토리
        roots = [d for d in dest.iterdir() if d.is_dir()]
        root = roots[0] if len(roots) == 1 else dest
        if subpath:
            root = root / subpath
            if not root.is_dir():
                raise ValueError(f"레포에 경로가 없습니다: {subpath!r}")
        docs = scan_directory(root)
    if not docs:
        raise ValueError("레포에서 콜렉션을 찾지 못했습니다 (bruno.json / *.postman_collection.json)")
    return docs


async def import_from_github(
    workspace: str, url: str, source: str = "prod", branch: str | None = None
) -> list[dict[str, Any]]:
    """GitHub 레포에서 콜렉션들을 찾아 workspace에 저장하고 요약 목록을 반환한다.

    레포 연결 정보(source)를 콜렉션에 남겨, 이후 `sync_collection`으로 같은 콜렉션
    id에 갱신(pull)할 수 있게 한다 — 워크플로우 참조가 유지된다.
    """
    docs = await _fetch_repo_docs(url)
    imported = []
    for doc in docs:
        doc["id"] = _new_id()
        doc["source"] = {"type": "github", "url": url.strip()}
        save_collection(workspace, doc, source, branch)
        imported.append(
            {"id": doc["id"], "name": doc["name"], "request_count": _count_requests(doc["items"])}
        )
    return imported


async def sync_collection(
    workspace: str, collection_id: str, source: str = "prod", branch: str | None = None
) -> dict[str, Any]:
    """GitHub에 연결된 콜렉션을 레포 최신 내용으로 in-place 갱신한다.

    콜렉션 id가 유지되므로 (폴더 경로·이름이 같은 요청에 한해) 워크플로우 참조가
    그대로 살아있고, 실시간 인덱스를 통해 변경이 즉시 반영된다.
    """
    doc = load_collection(workspace, collection_id, source, branch)
    if doc is None:
        raise ValueError("콜렉션을 찾을 수 없습니다")
    origin_meta = doc.get("source") or {}
    if origin_meta.get("type") != "github" or not origin_meta.get("url"):
        raise ValueError("GitHub에 연결된 콜렉션이 아닙니다 (source 없음)")

    docs = await _fetch_repo_docs(origin_meta["url"])
    # 레포에 콜렉션이 하나면 그것, 여럿이면 이름이 같은 것을 매칭
    matched = docs[0] if len(docs) == 1 else next((d for d in docs if d["name"] == doc["name"]), None)
    if matched is None:
        raise ValueError(f"레포에서 '{doc['name']}' 콜렉션을 찾지 못했습니다")

    matched["id"] = doc["id"]  # id 유지 — 워크플로우 참조 보존
    matched["source"] = origin_meta
    # 사용자가 고른 활성 환경이 여전히 존재하면 유지
    old_active = doc.get("activeEnvironment")
    env_names = {e.get("name") for e in matched.get("environments") or []}
    if old_active and old_active in env_names:
        matched["activeEnvironment"] = old_active
    save_collection(workspace, matched, source, branch)
    return matched


# ---------------------------------------------------------------------------
# Export — Bruno 콜렉션 JSON / Postman Collection v2.1
# ---------------------------------------------------------------------------
def export_collection(doc: dict[str, Any], fmt: str) -> dict[str, Any]:
    if fmt == "bruno":
        return _to_bruno(doc)
    if fmt == "postman":
        return _to_postman(doc)
    raise ValueError(f"지원하지 않는 형식입니다: {fmt!r} (bruno|postman)")


def _to_bruno(doc: dict[str, Any]) -> dict[str, Any]:
    def walk(items: list[Any]) -> list[dict[str, Any]]:
        out = []
        for i, item in enumerate(items):
            if not isinstance(item, dict):
                continue
            if item.get("type") == "folder":
                out.append(
                    {"type": "folder", "name": item.get("name"), "items": walk(item.get("items") or [])}
                )
                continue
            req = item.get("request") or {}
            body = req.get("body") or {"mode": "none"}
            exported: dict[str, Any] = {
                "type": "http",
                "name": item.get("name"),
                "seq": i + 1,
                "request": {
                    "method": req.get("method", "GET"),
                    "url": req.get("url", ""),
                    "headers": [
                        {
                            "name": h.get("name"),
                            "value": h.get("value"),
                            "enabled": h.get("enabled", True),
                            **({"description": h["description"]} if h.get("description") else {}),
                        }
                        for h in req.get("headers") or []
                    ],
                    "params": [
                        {
                            "name": p.get("name"),
                            "value": p.get("value"),
                            "type": p.get("kind", "query"),
                            "enabled": p.get("enabled", True),
                            **({"description": p["description"]} if p.get("description") else {}),
                        }
                        for p in req.get("params") or []
                    ],
                    "body": body,
                    "auth": {"mode": "none"},
                },
            }
            if req.get("output"):  # flowwork 확장 (응답 명세) — 재가져오기 시 보존
                exported["request"]["output"] = req["output"]
            out.append(exported)
        return out

    return {
        "name": doc.get("name"),
        "version": "1",
        "items": walk(doc.get("items") or []),
        "environments": [
            {
                "name": e.get("name"),
                "variables": [
                    {"name": v.get("name"), "value": v.get("value"), "enabled": v.get("enabled", True), "secret": False}
                    for v in e.get("variables") or []
                ],
            }
            for e in doc.get("environments") or []
        ],
        "exportedUsing": "flowwork",
    }


def _to_postman(doc: dict[str, Any]) -> dict[str, Any]:
    def walk(items: list[Any]) -> list[dict[str, Any]]:
        out = []
        for item in items:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "folder":
                out.append({"name": item.get("name"), "item": walk(item.get("items") or [])})
                continue
            req = item.get("request") or {}
            body = req.get("body") or {"mode": "none"}
            url = req.get("url", "")
            # 내부 params(query)는 Postman url.raw에 병합한다
            query = [
                p for p in req.get("params") or []
                if p.get("kind", "query") == "query" and p.get("enabled", True) and p.get("name")
            ]
            if query:
                qs = "&".join(f"{p['name']}={p.get('value', '')}" for p in query)
                url = f"{url}{'&' if '?' in url else '?'}{qs}"
            pm_req: dict[str, Any] = {
                "method": req.get("method", "GET"),
                "header": [
                    {
                        "key": h.get("name"),
                        "value": h.get("value"),
                        "disabled": not h.get("enabled", True),
                        **({"description": h["description"]} if h.get("description") else {}),
                    }
                    for h in req.get("headers") or []
                ],
                "url": {"raw": url},
            }
            if body.get("mode") in ("json", "text"):
                raw = body.get("json") if body.get("mode") == "json" else body.get("text")
                pm_req["body"] = {"mode": "raw", "raw": raw or ""}
                if body.get("mode") == "json":
                    pm_req["body"]["options"] = {"raw": {"language": "json"}}
            pm_item: dict[str, Any] = {"name": item.get("name"), "request": pm_req}
            if req.get("output"):  # flowwork 확장 (응답 명세)
                pm_item["_output"] = req["output"]
            out.append(pm_item)
        return out

    return {
        "info": {
            "name": doc.get("name"),
            "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
        },
        "item": walk(doc.get("items") or []),
    }
