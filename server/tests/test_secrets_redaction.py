import pytest

from app.redaction import REDACTED, redact_for_logging
from app.secrets import (
    SecretNotFoundError,
    resolve_environment_values,
    resolve_secret,
    resolve_vault_deep,
)


def test_redact_masks_sensitive_headers_only():
    req = {
        "url": "http://localhost/x",
        "headers": {"Authorization": "Bearer secret", "X-Trace": "keep-me"},
    }
    out = redact_for_logging(req)
    assert out["headers"]["Authorization"] == REDACTED
    assert out["headers"]["X-Trace"] == "keep-me"
    # 원본 불변
    assert req["headers"]["Authorization"] == "Bearer secret"


def test_resolve_secret_from_env(monkeypatch):
    monkeypatch.setenv("SECRET_PAYMENTS_API_TOKEN", "tok-123")
    assert resolve_secret("payments", "api-token") == "tok-123"


def test_resolve_secret_missing_raises(monkeypatch):
    monkeypatch.delenv("SECRET_PAYMENTS_MISSING", raising=False)
    with pytest.raises(SecretNotFoundError):
        resolve_secret("payments", "missing")


def test_resolve_vault_deep_replaces_embedded_tokens(monkeypatch):
    monkeypatch.setenv("SECRET_PAYMENTS_API_TOKEN", "tok-123")
    headers = {"Authorization": "Bearer vault://payments/api-token", "X-Keep": "raw"}
    body = {"nested": ["vault://payments/api-token", "plain"]}
    assert resolve_vault_deep(headers) == {
        "Authorization": "Bearer tok-123",
        "X-Keep": "raw",
    }
    assert resolve_vault_deep(body) == {"nested": ["tok-123", "plain"]}


def test_resolve_environment_values_only_touches_vault_refs(monkeypatch):
    monkeypatch.setenv("SECRET_PAYMENTS_API_TOKEN", "tok-123")
    env = {"baseUrl": "http://localhost", "authToken": "vault://payments/api-token"}
    resolved = resolve_environment_values(env)
    assert resolved["baseUrl"] == "http://localhost"
    assert resolved["authToken"] == "tok-123"
