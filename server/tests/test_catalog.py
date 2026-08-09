from app import bruno
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
    # output 명세가 있는 항목은 outputFields로 노출된다 (Bruno docs / Postman _output)
    user = by_name["사용자 정보 조회"]
    assert user.outputFields == ["app_user_id", "sec_user_id", "CIF", "name", "phone", "email"]
    # 명세가 없는 항목은 빈 목록
    assert by_name["정산 조회"].outputFields == []


def test_bruno_request_parse():
    text = """
meta {
  name: 계좌 출금
  type: http
  seq: 4
}

post {
  url: {{coreBaseUrl}}/accounts/{{accountNo}}/withdraw
  body: json
  auth: none
}

headers {
  Authorization: Bearer {{authToken}}
  Content-Type: application/json
}

body:json {
  {"amount": {{amount}}, "password": "{{password}}"}
}

docs {
  output: accountNo, status, balanceAfter
}
"""
    parsed = bruno.parse_request(text)
    assert parsed["name"] == "계좌 출금"
    req = parsed["request"]
    assert req["method"] == "POST"
    assert req["url"]["raw"] == "{{coreBaseUrl}}/accounts/{{accountNo}}/withdraw"
    assert req["header"][0] == {"key": "Authorization", "value": "Bearer {{authToken}}"}
    assert req["body"]["raw"] == '{"amount": {{amount}}, "password": "{{password}}"}'
    assert parsed["output"] == ["accountNo", "status", "balanceAfter"]
    # 정규화된 requestTemplate에서 변수 추출이 Postman과 동일하게 동작
    assert extract_template_variables(req) == ["authToken", "coreBaseUrl", "accountNo", "amount", "password"]


def test_bruno_environment_parse():
    text = "vars {\n  coreBaseUrl: http://localhost:9100/core\n}\n"
    assert bruno.parse_environment(text) == {"coreBaseUrl": "http://localhost:9100/core"}


def test_index_mixes_bruno_and_postman():
    entries, _ = build_index(CATALOG_DIR)
    by_name = {e.name: e for e in entries}
    # core는 Bruno(.bru), payments는 Postman JSON — 한 인덱스에 공존
    assert by_name["계좌 출금"].department == "core"
    assert by_name["계좌 출금"].collectionFile == "core"
    assert by_name["정산 조회"].collectionFile.endswith(".postman_collection.json")
