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


def test_output_fields_parsed_from_spec():
    entries, _ = build_index(CATALOG_DIR)
    by_name = {e.name: e for e in entries}
    # _output 명세가 있는 항목은 outputFields로 노출된다
    user = by_name["사용자 정보 조회"]
    assert user.outputFields == ["app_user_id", "sec_user_id", "CIF", "name", "phone", "email"]
    # _output이 없는 항목은 빈 목록
    assert by_name["정산 조회"].outputFields == []
