"""The server-side tripwire.

These tests care as much about what does *not* fire as about what does. A
guard that rejected every 12-digit order number would make the backend unusable
on ordinary e-commerce pages, and the team would turn it off.
"""

import base64
import hashlib

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.manifest_store import manifest_store
from app.agent.pii_guard import find_pii, is_aadhaar, is_valid_luhn
from app.agent.verifier import reject_if_pii
from app.schemas.page_ir import PageIR, PageElement

AADHAAR = "234567890124"  # Verhoeff-valid
DECOY = "234567890123"  # 12 digits, fails Verhoeff
CARD = "4111111111111111"
TICKET = "4111111111111112"  # 16 digits, fails Luhn


def ir(**over) -> PageIR:
    base = dict(
        url="https://example.test/",
        title="Account",
        elements=[],
        text_snippets=[],
        observed_at="2026-01-01T00:00:00Z",
    )
    base.update(over)
    return PageIR(**base)


class TestValidators:
    """The validators must agree with the extension's, or the guard misfires."""

    def test_verhoeff_accepts_a_real_aadhaar_and_rejects_the_decoy(self):
        assert is_aadhaar(AADHAAR)
        assert not is_aadhaar(DECOY)

    def test_luhn_accepts_a_real_card_and_rejects_the_decoy(self):
        assert is_valid_luhn(CARD)
        assert not is_valid_luhn(TICKET)

    def test_aadhaar_cannot_start_with_zero_or_one(self):
        assert not is_aadhaar("012345678901")


class TestFindPii:
    def test_names_the_kind_it_found(self):
        assert find_pii(f"UID {AADHAAR}") == "AADHAAR"
        assert find_pii("PAN ABCDE1234F") == "PAN"
        assert find_pii("write to me at a@b.co") == "EMAIL"

    def test_returns_none_for_clean_text(self):
        assert find_pii("Welcome back, your order has shipped") is None
        assert find_pii("") is None

    def test_does_not_fire_on_a_decoy_order_number(self):
        # The case that separates a validated detector from a regex.
        assert find_pii(f"Order {DECOY} dispatched") is None

    def test_does_not_fire_on_a_decoy_ticket_number(self):
        assert find_pii(f"Ticket {TICKET}") is None


class TestRejectIfPii:
    def test_passes_a_properly_redacted_observation(self):
        reject_if_pii(ir(text_snippets=["Your order has shipped", f"Order {DECOY}"]))

    def test_rejects_pii_in_a_text_snippet(self):
        with pytest.raises(ValueError) as e:
            reject_if_pii(ir(text_snippets=[f"UID {AADHAAR}"]))
        assert "AADHAAR" in str(e.value)

    def test_rejects_pii_in_the_url_and_the_title(self):
        with pytest.raises(ValueError):
            reject_if_pii(ir(url=f"https://x.test/?uid={AADHAAR}"))
        with pytest.raises(ValueError):
            reject_if_pii(ir(title=f"Account {CARD}"))

    def test_rejects_pii_in_an_element_value(self):
        el = PageElement(id="e1", role="textbox", name="Card", value=CARD)
        with pytest.raises(ValueError) as e:
            reject_if_pii(ir(elements=[el]))
        assert "CARD" in str(e.value)
        assert "e1" in str(e.value)

    def test_never_repeats_the_value_it_caught(self):
        # The guard fires exactly when something has already gone wrong.
        # Writing the number into the error would leak it a second time, into
        # the server log this time.
        with pytest.raises(ValueError) as e:
            reject_if_pii(ir(text_snippets=[f"UID {AADHAAR}"]))
        assert AADHAAR not in str(e.value)

    def test_says_it_is_a_client_bug(self):
        with pytest.raises(ValueError) as e:
            reject_if_pii(ir(title=f"Card {CARD}"))
        assert "client bug" in str(e.value)


class TestStepEndpoint:
    @pytest.fixture(autouse=True)
    def _clear(self):
        manifest_store.clear()
        yield
        manifest_store.clear()

    def _post(self, page_ir: dict):
        with TestClient(app) as client:
            return client.post(
                "/agent/step",
                json={"session_id": "t1", "goal": "do a thing", "page_ir": page_ir},
            )

    def test_rejects_an_observation_carrying_pii(self):
        r = self._post(ir(text_snippets=[f"UID {AADHAAR}"]).model_dump())
        assert r.status_code == 422
        assert "AADHAAR" in r.json()["detail"]
        assert AADHAAR not in r.json()["detail"]

    def test_records_the_image_hash_and_size_in_the_manifest(self):
        png = b"\x89PNG\r\n\x1a\n-pretend-redacted-bytes"
        payload = ir(screenshot_b64=base64.b64encode(png).decode()).model_dump()
        self._post(payload)

        shots = [e for e in manifest_store.list_entries() if e.action_type == "screenshot"]
        assert len(shots) == 1
        assert shots[0].details["image_sha256"] == hashlib.sha256(png).hexdigest()
        assert shots[0].details["image_bytes"] == len(png)

    def test_records_no_image_entry_when_no_image_was_sent(self):
        self._post(ir().model_dump())
        assert [e for e in manifest_store.list_entries() if e.action_type == "screenshot"] == []

    def test_the_manifest_stores_the_hash_and_not_the_image(self):
        png = b"\x89PNG\r\n\x1a\n-pretend-redacted-bytes"
        b64 = base64.b64encode(png).decode()
        self._post(ir(screenshot_b64=b64).model_dump())
        # A manifest that held the bytes would be the screenshot store this
        # design exists to avoid.
        for entry in manifest_store.list_entries():
            assert b64 not in str(entry.model_dump())
