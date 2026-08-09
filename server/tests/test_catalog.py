from app.catalog import build_index, extract_template_variables
from app.config import CATALOG_DIR


def test_extract_template_variables_dedup_and_order():
    template = {
        "url": {"raw": "{{baseUrl}}/api/customers/{{customerId}}/settle"},
        "body": {"raw": "{\"amount\": {{amount}}, \"who\": \"{{customerId}}\"}"},
    }
    assert extract_template_variables(template) == ["baseUrl", "customerId", "amount"]


def test_build_index_flattens_folder_tree():
    entries, _ = build_index(CATALOG_DIR)
    by_name = {e.name: e for e in entries}

    assert "정산 조회" in by_name
    assert "정산 취소" in by_name

    lookup = by_name["정산 조회"]
    assert lookup.department == "payments"
    assert lookup.itemPath == ["정산"]
    assert lookup.method == "GET"
    assert "customerId" in lookup.variables
    assert "baseUrl" in lookup.variables


def test_entry_ids_are_stable_and_unique():
    entries, _ = build_index(CATALOG_DIR)
    ids = [e.id for e in entries]
    assert len(ids) == len(set(ids))
