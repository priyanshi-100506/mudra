import pytest
from fastapi.testclient import TestClient
from app.main import app
from app.manifest_store import manifest_store

client = TestClient(app)


@pytest.fixture(autouse=True)
def clear_manifest_store():
    manifest_store.clear()
    yield
    manifest_store.clear()


def test_record_and_list_manifests():
    payload = {
        "session_id": "sess_123",
        "target_url": "https://example.com/checkout",
        "action_type": "type",
        "status": "allowed",
        "redacted_refs_count": 2,
        "details": {"ref": "ref_abc123"}
    }
    response = client.post("/manifest/record", json=payload)
    assert response.status_code == 200
    data = response.json()
    assert data["session_id"] == "sess_123"
    assert data["status"] == "allowed"
    assert "id" in data

    # List manifests
    list_res = client.get("/manifests")
    assert list_res.status_code == 200
    entries = list_res.json()
    assert len(entries) == 1
    assert entries[0]["id"] == data["id"]


def test_filter_manifests_by_status():
    client.post("/manifest/record", json={
        "session_id": "s1", "target_url": "https://a.com", "action_type": "click", "status": "allowed"
    })
    client.post("/manifest/record", json={
        "session_id": "s1", "target_url": "https://b.com", "action_type": "submit_form", "status": "refused"
    })

    allowed_res = client.get("/manifests?status=allowed")
    assert allowed_res.status_code == 200
    assert len(allowed_res.json()) == 1
    assert allowed_res.json()[0]["action_type"] == "click"

    refused_res = client.get("/manifests?status=refused")
    assert refused_res.status_code == 200
    assert len(refused_res.json()) == 1
    assert refused_res.json()[0]["action_type"] == "submit_form"


def test_get_single_manifest_entry():
    rec = client.post("/manifest/record", json={
        "session_id": "s2", "target_url": "https://bank.com", "action_type": "type", "status": "allowed"
    }).json()

    entry_id = rec["id"]
    res = client.get(f"/manifests/{entry_id}")
    assert res.status_code == 200
    assert res.json()["id"] == entry_id

    # Non-existent entry
    not_found = client.get("/manifests/non_existent_id")
    assert not_found.status_code == 404


def test_manifest_viewer_html():
    client.post("/manifest/record", json={
        "session_id": "s3", "target_url": "https://gov.in", "action_type": "click", "status": "allowed"
    })

    res = client.get("/manifests/viewer/html")
    assert res.status_code == 200
    assert "text/html" in res.headers["content-type"]
    assert "MUDRA Egress Audit Manifest Viewer" in res.text
    assert "https://gov.in" in res.text
