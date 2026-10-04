"""Credentials and credential types (PLATFORM_PLAN.md §13): the encrypted
store, the write-only API, scopes and grants, admin-defined types, and the
audit log.

The rule every test here leans on: no response ever carries a secret value.
`_Recorder` wraps the admin client and keeps every response body, so a test
can drive a whole lifecycle and then assert the secret appeared in none."""

import base64
import datetime
import json
import logging

import pytest
from fastapi.testclient import TestClient

from app import credential_store, credential_types, crypto, keys, masking, models
from app.db import SessionLocal
from app.main import app
from tests.conftest import client

K1 = base64.b64encode(b"1" * 32).decode()
K2 = base64.b64encode(b"2" * 32).decode()
SECRET = "hunter2-very-secret-value"


@pytest.fixture(autouse=True)
def _master_key(monkeypatch):
    monkeypatch.setenv(crypto.KEYS_ENV, f"k1:{K1}")
    monkeypatch.setenv(crypto.CURRENT_ENV, "k1")
    masking.reset()


class _Recorder:
    """The admin client, keeping every response's body."""

    def __init__(self, c: TestClient):
        self.c, self.bodies = c, []

    def __getattr__(self, method):
        def call(*args, **kwargs):
            resp = getattr(self.c, method)(*args, **kwargs)
            self.bodies.append(resp.text)
            return resp

        return call

    def assert_never_saw(self, value: str) -> None:
        leaked = [b for b in self.bodies if value in b]
        assert not leaked, f"a response carried the secret: {leaked[0][:200]}"


def _login_as(username: str, password: str) -> TestClient:
    c = TestClient(app)
    resp = c.post("/api/auth/login", json={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return c


def _group(name: str) -> tuple[int, TestClient]:
    resp = client.post("/api/user-groups", json={"name": name, "role_name": "R"})
    assert resp.status_code == 201, resp.text
    group_id = resp.json()["id"]
    username = f"user-{name}"
    assert client.post("/api/users", json={"username": username, "password": "pw-123456", "group_id": group_id}).status_code == 201
    return group_id, _login_as(username, "pw-123456")


def _admin_group_id() -> int:
    return next(g["id"] for g in client.get("/api/user-groups").json() if g["is_admin"])


def _create(c=client, **overrides) -> dict:
    body = {
        "name": "deploy-login",
        "type_id": "username_password",
        "scope": "group",
        "group_id": _admin_group_id(),
        "values": {"username": "deployer", "password": SECRET},
        **overrides,
    }
    resp = c.post("/api/credentials", json=body)
    assert resp.status_code == 201, resp.text
    return resp.json()


def _user(db, username: str = "admin") -> models.User:
    return db.query(models.User).filter(models.User.username == username).one()


def _resolve(credential_id: int, username: str = "admin"):
    db = SessionLocal()
    try:
        return credential_store.resolve(db, credential_id, actor=_user(db, username), purpose="test")
    finally:
        db.close()


# ------------------------------------------------------------------- keys


def test_without_a_master_key_credentials_are_off_but_everything_else_works(monkeypatch):
    monkeypatch.delenv(crypto.KEYS_ENV)
    status = client.get("/api/credentials/status").json()
    assert status["enabled"] is False and "no master key" in status["reason"]
    resp = client.post("/api/credentials", json={"name": "x", "type_id": "secret_text", "scope": "global", "values": {"value": "abcd"}})
    assert resp.status_code == 503 and "DEPLOYMENT.md" in resp.json()["detail"]
    assert client.get("/api/environments").status_code == 200
    assert client.get("/api/credential-types").status_code == 200


def test_a_malformed_keyring_is_refused_loudly_not_taken_as_no_key(monkeypatch):
    monkeypatch.setenv(crypto.KEYS_ENV, "k1:not-base64!!")
    status = client.get("/api/credentials/status").json()
    assert status["enabled"] is False and "isn't valid base64" in status["reason"]
    monkeypatch.setenv(crypto.KEYS_ENV, f"k1:{base64.b64encode(b'short').decode()}")
    assert "must be 32 bytes" in client.get("/api/credentials/status").json()["reason"]


def test_the_wrong_master_key_is_refused_with_a_reason(monkeypatch):
    cred = _create()
    monkeypatch.setenv(crypto.KEYS_ENV, f"k1:{K2}")  # same id, different key
    resp = client.post(f"/api/credentials/{cred['id']}/test")
    assert resp.status_code == 400 and "doesn't match" in resp.json()["detail"]
    monkeypatch.setenv(crypto.KEYS_ENV, f"k9:{K2}")
    monkeypatch.setenv(crypto.CURRENT_ENV, "k9")
    resp = client.post(f"/api/credentials/{cred['id']}/test")
    assert "master key 'k1', which isn't in" in resp.json()["detail"]


def test_a_ciphertext_moved_to_another_row_does_not_decrypt():
    a = _create(name="a")
    b = _create(name="b", values={"username": "other", "password": "another-secret"})
    db = SessionLocal()
    try:
        row_a, row_b = db.get(models.Credential, a["id"]), db.get(models.Credential, b["id"])
        row_b.secret_ciphertext, row_b.secret_nonce = row_a.secret_ciphertext, row_a.secret_nonce
        row_b.wrapped_dek, row_b.kek_id = row_a.wrapped_dek, row_a.kek_id
        db.commit()
    finally:
        db.close()
    with pytest.raises(credential_store.CredentialError, match="don't belong to it"):
        _resolve(b["id"])
    assert _resolve(a["id"])[1]["password"] == SECRET


def test_rotation_rewraps_every_data_key_and_secrets_still_decrypt(monkeypatch, capsys):
    cred = _create()
    monkeypatch.setenv(crypto.KEYS_ENV, f"k2:{K2},k1:{K1}")
    monkeypatch.setenv(crypto.CURRENT_ENV, "k2")
    assert keys.main(["rotate"]) == 0
    db = SessionLocal()
    try:
        assert db.get(models.Credential, cred["id"]).kek_id == "k2"
    finally:
        db.close()
    # With the old key gone, everything still decrypts.
    monkeypatch.setenv(crypto.KEYS_ENV, f"k2:{K2}")
    assert keys.main(["check"]) == 0
    assert _resolve(cred["id"])[1]["password"] == SECRET
    assert "Re-wrapped 1" in capsys.readouterr().out


# ------------------------------------------------------------------- write-only


def test_no_response_ever_carries_a_secret_value():
    rec = _Recorder(client)
    cred = rec.post("/api/credentials", json={
        "name": "jira", "type_id": "username_password", "scope": "global",
        "values": {"username": "bot", "password": SECRET},
    }).json()
    assert cred["secret_fields_set"] == ["password"] and cred["public_fields"] == {"username": "bot"}
    rec.get("/api/credentials")
    rec.get(f"/api/credentials/{cred['id']}")
    rec.patch(f"/api/credentials/{cred['id']}", json={"name": "jira-bot"})
    rec.patch(f"/api/credentials/{cred['id']}", json={"values": {"username": "bot2"}})
    rec.post(f"/api/credentials/{cred['id']}/test")
    rec.post(f"/api/credentials/{cred['id']}/grants/{_admin_group_id()}")
    rec.get(f"/api/audit?object=credential:{cred['id']}")
    rec.get("/api/credential-types")
    rec.assert_never_saw(SECRET)
    # The password survived every one of those edits.
    assert _resolve(cred["id"])[1] == {"username": "bot2", "password": SECRET}


def test_a_secret_left_out_or_sent_empty_is_kept_and_clear_empties_it():
    cred = _create(type_id="api_token", name="gh", values={"token": SECRET})
    client.patch(f"/api/credentials/{cred['id']}", json={"values": {"scheme": "token", "token": ""}})
    assert _resolve(cred["id"])[1] == {"token": SECRET, "scheme": "token"}
    resp = client.patch(f"/api/credentials/{cred['id']}", json={"clear": ["token"]})
    assert resp.status_code == 400 and "Fill in Token" in resp.json()["detail"]
    out = client.patch(f"/api/credentials/{cred['id']}", json={"clear": ["scheme"]}).json()
    assert out["public_fields"] == {} and out["secret_fields_set"] == ["token"]


def test_required_and_unknown_fields_are_refused_readably():
    resp = client.post("/api/credentials", json={"name": "x", "type_id": "username_password", "scope": "global", "values": {"username": "u"}})
    assert resp.status_code == 400 and resp.json()["detail"] == "Fill in Password."
    resp = client.post("/api/credentials", json={"name": "x", "type_id": "secret_text", "scope": "global", "values": {"value": "abcd", "oops": 1}})
    assert resp.status_code == 400 and "no field oops" in resp.json()["detail"]
    _create(name="dup")
    resp = client.post("/api/credentials", json={"name": "dup", "type_id": "secret_text", "scope": "group",
                                                 "group_id": _admin_group_id(), "values": {"value": "abcd"}})
    assert resp.status_code == 400 and "already exists in this group" in resp.json()["detail"]


def test_a_secret_file_is_capped_at_one_mebibyte():
    big = base64.b64encode(b"x" * (1024 * 1024 + 1)).decode()
    resp = client.post("/api/credentials", json={"name": "f", "type_id": "secret_file", "scope": "global",
                                                 "values": {"filename": "key.p12", "content": big}})
    assert resp.status_code == 400 and "limited to 1 MiB" in resp.json()["detail"]


# ------------------------------------------------------------------- scopes


def test_groups_see_only_their_own_credentials_and_granted_global_ones():
    group_a, as_a = _group("alpha")
    group_b, _as_b = _group("beta")
    mine = _create(name="alpha-login", group_id=group_a)
    theirs = _create(name="beta-login", group_id=group_b)
    shared = _create(name="shared", scope="global", group_id=None)

    listed = as_a.get("/api/credentials").json()
    assert [c["name"] for c in listed] == ["alpha-login"]
    assert set(listed[0]) == {"id", "name", "type_id", "type_label", "scope", "authenticates"}  # names, not contents

    assert client.post(f"/api/credentials/{shared['id']}/grants/{group_a}").status_code == 204
    assert {c["name"] for c in as_a.get("/api/credentials").json()} == {"alpha-login", "shared"}
    assert _resolve(shared["id"], "user-alpha")[1]["password"] == SECRET
    assert _resolve(mine["id"], "user-alpha")[1]["username"] == "deployer"
    with pytest.raises(credential_store.CredentialAccessError):
        _resolve(theirs["id"], "user-alpha")

    assert client.delete(f"/api/credentials/{shared['id']}/grants/{group_a}").status_code == 204
    with pytest.raises(credential_store.CredentialAccessError):
        _resolve(shared["id"], "user-alpha")
    # Managing credentials is the admins' alone (D24).
    assert as_a.post("/api/credentials", json={"name": "x", "type_id": "secret_text", "scope": "group",
                                               "group_id": group_a, "values": {"value": "abcd"}}).status_code == 403
    assert as_a.get(f"/api/credentials/{mine['id']}").status_code == 403


def test_a_group_credential_can_not_be_granted():
    cred = _create()
    resp = client.post(f"/api/credentials/{cred['id']}/grants/{_admin_group_id()}")
    assert resp.status_code == 400 and "Only global credentials" in resp.json()["detail"]


# ------------------------------------------------------------------- types


def test_built_in_types_are_seeded_and_locked():
    types = {t["id"]: t for t in client.get("/api/credential-types").json()}
    assert set(credential_types.BUILTIN_IDS) <= set(types)
    assert all(types[i]["builtin"] for i in credential_types.BUILTIN_IDS)
    assert client.patch("/api/credential-types/username_password", json={"label": "x"}).status_code == 403
    assert client.delete("/api/credential-types/username_password").status_code == 403


def test_a_custom_type_from_a_pasted_example_keeps_the_pasted_shape():
    inferred = client.post("/api/credential-types/infer", json={"example": {
        "userName": "", "password": "", "auth": {"tenant": "acme"}, "port": 443,
    }}).json()
    by_key = {f["key"]: f for f in inferred["fields"]}
    assert set(by_key) == {"user_name", "password", "auth_tenant", "port"}
    assert by_key["password"]["secret"] and not by_key["user_name"]["secret"]
    assert by_key["auth_tenant"]["default"] == "acme" and by_key["port"]["kind"] == "number"
    assert inferred["output_template"]

    resp = client.post("/api/credential-types", json={"id": "acme_api", "label": "Acme API", **inferred})
    assert resp.status_code == 201, resp.text
    cred = _create(name="acme", type_id="acme_api", values={"user_name": "bob", "password": SECRET})
    type_row, values = _resolve(cred["id"])
    assert credential_types.render(type_row, values) == {
        "userName": "bob", "password": SECRET, "auth": {"tenant": "acme"}, "port": 443,
    }
    preview = client.post("/api/credential-types/preview", json={
        "fields": inferred["fields"], "output_template": inferred["output_template"],
        "values": {"user_name": "u", "password": "p"},
    }).json()
    assert preview["output"]["auth"] == {"tenant": "acme"}


def test_a_type_definition_is_checked_before_it_is_stored():
    bad = [
        ({"fields": []}, "at least one field"),
        ({"fields": [{"key": "in", "kind": "text"}]}, "reserved word"),
        ({"fields": [{"key": "Bad-Key"}]}, "isn't a valid field key"),
        ({"fields": [{"key": "a", "secret": True, "default": "x"}]}, "can't have a default"),
        ({"fields": [{"key": "a"}], "output_template": "{'x': "}, "doesn't compile"),
        ({"fields": [{"key": "a"}], "output_template": "nope"}, "undeclared reference"),
        ({"fields": [{"key": "a"}], "inject": {"kind": "header", "value": "a"}}, "needs the header's name"),
    ]
    for body, message in bad:
        resp = client.post("/api/credential-types", json={"id": "t_bad", "label": "Bad", **body})
        assert resp.status_code == 400 and message in resp.json()["detail"], (body, resp.text)


def test_editing_a_type_in_use_keeps_stored_values_safe():
    client.post("/api/credential-types", json={"id": "svc", "label": "Service", "fields": [
        {"key": "host", "required": True}, {"key": "key", "secret": True, "required": True}, {"key": "region"},
    ]})
    cred = _create(name="svc1", type_id="svc", values={"host": "h.example", "key": SECRET, "region": "eu"})

    # A secret field can never be made public again.
    resp = client.patch("/api/credential-types/svc", json={"fields": [
        {"key": "host", "required": True}, {"key": "key", "required": True}, {"key": "region"}]})
    assert resp.status_code == 400 and "can't be made public" in resp.json()["detail"]

    # Making a public field secret moves its stored value into the ciphertext.
    resp = client.patch("/api/credential-types/svc", json={"fields": [
        {"key": "host", "required": True}, {"key": "key", "secret": True, "required": True},
        {"key": "region", "secret": True}]})
    assert resp.status_code == 200 and resp.json()["version"] == 2
    out = client.get(f"/api/credentials/{cred['id']}").json()
    assert out["public_fields"] == {"host": "h.example"} and out["secret_fields_set"] == ["key", "region"]
    assert _resolve(cred["id"])[1] == {"host": "h.example", "key": SECRET, "region": "eu"}

    # Removing a field that holds values asks first, then drops them.
    two = [{"key": "host", "required": True}, {"key": "key", "secret": True, "required": True}]
    resp = client.patch("/api/credential-types/svc", json={"fields": two})
    assert resp.status_code == 409 and "svc1" in resp.json()["detail"]
    assert client.patch("/api/credential-types/svc", json={"fields": two, "confirm_remove": True}).status_code == 200
    assert _resolve(cred["id"])[1] == {"host": "h.example", "key": SECRET}

    # A type in use can't be deleted.
    resp = client.delete("/api/credential-types/svc")
    assert resp.status_code == 409 and "svc1" in resp.json()["detail"]
    client.delete(f"/api/credentials/{cred['id']}")
    assert client.delete("/api/credential-types/svc").status_code == 204


# ------------------------------------------------------------------- inject and tests


def test_inject_authenticates_a_request_for_built_in_and_custom_types():
    db = SessionLocal()
    try:
        token = db.get(models.CredentialType, "api_token")
        assert credential_types.apply_inject(token, {"token": "t0k"}, "https://x.example/a", {})[1] == {
            "Authorization": "Bearer t0k"
        }
        assert credential_types.apply_inject(token, {"token": "t0k", "scheme": ""}, "https://x", {})[1] == {
            "Authorization": "t0k"
        }
        basic = db.get(models.CredentialType, "username_password")
        header = credential_types.apply_inject(basic, {"username": "u", "password": "p"}, "https://x", {})[1]
        assert header["Authorization"] == "Basic " + base64.b64encode(b"u:p").decode()
    finally:
        db.close()
    client.post("/api/credential-types", json={"id": "query_key", "label": "Query key",
                                               "fields": [{"key": "key", "secret": True, "required": True}],
                                               "inject": {"kind": "query", "name": "api_key", "value": "key"}})
    db = SessionLocal()
    try:
        url, _ = credential_types.apply_inject(db.get(models.CredentialType, "query_key"), {"key": "k1"}, "https://x.example/a?b=1", {})
        assert url == "https://x.example/a?b=1&api_key=k1"
    finally:
        db.close()


def test_a_custom_types_http_test_goes_through_the_ssrf_guard(monkeypatch):
    client.post("/api/credential-types", json={
        "id": "acme_token", "label": "Acme token",
        "fields": [{"key": "host", "required": True}, {"key": "token", "secret": True, "required": True}],
        "inject": {"kind": "header", "name": "Authorization", "value": '"Bearer " + token'},
        "http_test": {"method": "GET", "url": '"https://" + host + "/me"'},
    })
    internal = _create(name="internal", type_id="acme_token", values={"host": "127.0.0.1", "token": SECRET})
    out = client.post(f"/api/credentials/{internal['id']}/test").json()
    assert out["ok"] is False and SECRET not in json.dumps(out)

    sent = {}

    def fake_send(method, url, headers=None, body=None, timeout=30):
        sent.update(method=method, url=url, headers=headers)
        return {"status_code": 401, "status_text": f"Unauthorized (token {SECRET})", "headers": [], "body": "",
                "body_truncated": False, "elapsed_ms": 1}

    from app import tools_http_client
    monkeypatch.setattr(tools_http_client, "send_request", fake_send)
    public = _create(name="public", type_id="acme_token", values={"host": "api.acme.example", "token": SECRET})
    out = client.post(f"/api/credentials/{public['id']}/test").json()
    assert sent == {"method": "GET", "url": "https://api.acme.example/me", "headers": {"Authorization": f"Bearer {SECRET}"}}
    # A response echoing the token is masked before it's stored or shown.
    assert out == {"ok": False, "message": "HTTP 401 Unauthorized (token ****)"}


def test_built_in_checks_load_keys_and_certificates(monkeypatch):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec, ed25519
    from cryptography.x509.oid import NameOID

    ssh = ed25519.Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM, serialization.PrivateFormat.OpenSSH, serialization.NoEncryption()
    ).decode()
    cred = _create(name="ssh", type_id="ssh_key", values={"private_key": ssh})
    out = client.post(f"/api/credentials/{cred['id']}/test").json()
    assert out["ok"] is True and out["message"].startswith("ssh-ed25519 key, SHA256:")

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "svc.example")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
        .serial_number(1).not_valid_before(now).not_valid_after(now + datetime.timedelta(days=10)).sign(key, hashes.SHA256())
    )
    pem = lambda k: k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()).decode()  # noqa: E731
    cert_pem = cert.public_bytes(serialization.Encoding.PEM).decode()
    good = _create(name="tls", type_id="certificate", values={"certificate": cert_pem, "private_key": pem(key)})
    out = client.post(f"/api/credentials/{good['id']}/test").json()
    assert out["ok"] is True and "CN=svc.example" in out["message"] and "Expires in" in out["message"]
    other = ec.generate_private_key(ec.SECP256R1())
    bad = _create(name="tls2", type_id="certificate", values={"certificate": cert_pem, "private_key": pem(other)})
    assert client.post(f"/api/credentials/{bad['id']}/test").json() == {
        "ok": False, "message": "The private key doesn't belong to this certificate."
    }

    import boto3

    class _Sts:
        def get_caller_identity(self):
            return {"Account": "123456789012", "Arn": "arn:aws:iam::123456789012:user/ci"}

    seen = {}
    monkeypatch.setattr(boto3, "client", lambda service, **kw: seen.update(service=service, **kw) or _Sts())
    aws = _create(name="aws", type_id="aws_access_keys", values={"access_key_id": "AKIAEXAMPLE", "secret_access_key": SECRET})
    out = client.post(f"/api/credentials/{aws['id']}/test").json()
    assert out == {"ok": True, "message": "Account 123456789012, arn:aws:iam::123456789012:user/ci"}
    assert seen["service"] == "sts" and seen["aws_secret_access_key"] == SECRET
    listed = client.get(f"/api/credentials/{aws['id']}").json()
    assert listed["last_test_ok"] is True and listed["last_tested_at"]


# ------------------------------------------------------------------- audit and masking


def test_every_action_is_audited_without_values():
    cred = _create(scope="global", group_id=None)
    client.patch(f"/api/credentials/{cred['id']}", json={"values": {"password": "new-secret-value"}})
    client.post(f"/api/credentials/{cred['id']}/test")
    client.post(f"/api/credentials/{cred['id']}/grants/{_admin_group_id()}")
    client.delete(f"/api/credentials/{cred['id']}/grants/{_admin_group_id()}")
    _resolve(cred["id"])
    events = client.get(f"/api/audit?object=credential:{cred['id']}").json()
    assert [e["action"] for e in reversed(events)] == [
        "credential.create", "credential.update", "credential.test", "credential.grant", "credential.revoke", "credential.use",
    ]
    assert next(e for e in events if e["action"] == "credential.update")["detail"] == {"changed": ["password"]}
    assert all(e["actor_name"] == "admin" for e in events)
    assert "new-secret-value" not in json.dumps(events) and SECRET not in json.dumps(events)
    client.delete(f"/api/credentials/{cred['id']}")
    assert client.get(f"/api/audit?object=credential:{cred['id']}").json()[0]["action"] == "credential.delete"


def test_what_a_request_decrypted_is_masked_in_its_log_lines(caplog):
    masking.install()
    cred = _create()
    _resolve(cred["id"])
    with caplog.at_level(logging.WARNING):
        logging.getLogger("anything").warning("calling with %s", SECRET)
    assert SECRET not in caplog.text and "calling with ****" in caplog.text
    masking.reset()
    with caplog.at_level(logging.WARNING):
        logging.getLogger("anything").warning("after the request: %s", SECRET)
    assert f"after the request: {SECRET}" in caplog.text


# ------------------------------------------------------------------- the HTTP client's Auth (§13.8)


def test_the_http_client_authenticates_with_a_credential_server_side(monkeypatch):
    from app import tools_http_client

    sent = {}

    def echo(method, url, headers=None, body=None, timeout=30):
        sent.update(url=url, headers=headers)
        # An echoing server (httpbin and friends) hands the secret back.
        return {"status_code": 200, "status_text": "OK", "headers": [{"key": "X-Echo", "value": headers.get("Authorization", "")}],
                "body": json.dumps({"headers": headers}), "body_truncated": False, "elapsed_ms": 3}

    monkeypatch.setattr(tools_http_client, "send_request", echo)
    cred = _create(name="api", type_id="api_token", values={"token": SECRET})
    resp = client.post("/api/tools/http-request", json={"method": "GET", "url": "https://api.example.com/me",
                                                        "headers": [{"key": "Accept", "value": "application/json"}],
                                                        "credential_id": cred["id"]})
    assert resp.status_code == 200, resp.text
    assert sent["headers"] == {"Accept": "application/json", "Authorization": f"Bearer {SECRET}"}
    assert SECRET not in resp.text and "Bearer ****" in resp.text
    use = client.get(f"/api/audit?object=credential:{cred['id']}").json()[0]
    assert use["action"] == "credential.use" and use["detail"] == {"purpose": "HTTP client: GET api.example.com"}

    # A credential whose type doesn't say how to authenticate is refused, readably.
    plain = _create(name="plain", type_id="secret_text", values={"value": SECRET})
    resp = client.post("/api/tools/http-request", json={"method": "GET", "url": "https://api.example.com/", "credential_id": plain["id"]})
    assert resp.status_code == 400 and "don't say how to authenticate" in resp.json()["detail"]


def test_the_http_client_can_not_use_another_groups_credential(monkeypatch):
    from app import tools_http_client

    monkeypatch.setattr(tools_http_client, "send_request", lambda *a, **k: pytest.fail("must not be sent"))
    group_b, _ = _group("beta")
    theirs = _create(name="beta-api", type_id="api_token", group_id=group_b, values={"token": SECRET})
    resp = client.post("/api/user-groups", json={"name": "alpha", "role_name": "R", "tools_enabled": True})
    alpha = resp.json()["id"]
    client.post("/api/users", json={"username": "ann", "password": "pw-123456", "group_id": alpha})
    as_ann = _login_as("ann", "pw-123456")
    resp = as_ann.post("/api/tools/http-request", json={"method": "GET", "url": "https://api.example.com/", "credential_id": theirs["id"]})
    assert resp.status_code == 404 and "isn't available to your group" in resp.json()["detail"]
    assert as_ann.get("/api/credentials").json() == []


def test_the_agent_sees_credential_names_and_sets_one_by_name_never_its_value():
    from tests.test_platform_tools import _token, call, call_error

    cred = _create(name="jira-bot", type_id="api_token", values={"token": SECRET})
    with TestClient(app) as mcp:
        token = _token()
        context = call(mcp, token, "get_context")
        assert {"id": cred["id"], "name": "jira-bot", "type": "API token", "authenticates": True} in context["credentials"]
        assert SECRET not in json.dumps(context)
        session = call(mcp, token, "create_session", title="Calls", panes=[{"kind": "tool-http"}])["session_id"]
        out = call(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-http",
                   inputs={"url": "https://api.example.com/me", "credentialId": "jira-bot"})
        assert out["pane"]["inputs"]["credentialId"] == cred["id"] and SECRET not in json.dumps(out)
        error = call_error(mcp, token, "set_pane_inputs", session_id=session, pane_id="tool-http",
                           inputs={"credentialId": "nope"})
        assert "no credential 'nope'" in error and "jira-bot" in error
