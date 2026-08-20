from __future__ import annotations

import copy
import hashlib
import json
import re
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError


ROOT = Path(__file__).resolve().parents[1]
IDEMPOTENCY_KEY_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")


def _schema() -> dict[str, object]:
    return json.loads((ROOT / "schemas" / "commons-evidence-envelope-v1.json").read_text())


def _payload() -> dict[str, object]:
    return {
        "schema_version": "1.0",
        "model_namespace": "openai/gpt-5.6-sol",
        "atoms": [
            {
                "record_type": "decision",
                "action_kind": "tool",
                "cost_bucket": "low",
                "gain_bucket": "medium",
                "recommendation": "allow",
                "applied_decision": "allow",
                "reason_code": "APPROVED",
                "outcome_class": "not_applicable",
                "count": 1,
                "minimum_group_size": 1,
            }
        ],
    }


def _validator() -> Draft202012Validator:
    return Draft202012Validator(_schema())


def _assert_invalid(validator: Draft202012Validator, payload: object) -> None:
    with pytest.raises(ValidationError):
        validator.validate(payload)


def test_ingress_envelope_contract_is_closed_and_accepts_a_safe_aggregate() -> None:
    _validator().validate(_payload())


@pytest.mark.parametrize(
    "mutate",
    [
        lambda value: value.update({"canary": "customer-acme"}),
        lambda value: value.update({"url": "https://example.invalid/private"}),
        lambda value: value.update({"path": "/private/customer/acme"}),
        lambda value: value.update({"sha256": "a" * 64}),
        lambda value: value["atoms"][0].update({"metadata": {"canary": "customer-acme"}}),
        lambda value: value["atoms"][0].update({"url": "https://example.invalid/private"}),
        lambda value: value["atoms"][0].update({"path": "/private/customer/acme"}),
        lambda value: value["atoms"][0].update({"sha256": "a" * 64}),
        lambda value: value.update({"model_namespace": "openai/gpt-5.6-sol-private"}),
        lambda value: value["atoms"][0].update({"reason_code": "ARBITRARY"}),
        lambda value: value["atoms"][0].update({"count": 1001}),
        lambda value: value.update({"atoms": []}),
    ],
)
def test_ingress_envelope_rejects_privacy_and_contract_violations(mutate: object) -> None:
    payload = _payload()
    mutate(payload)  # type: ignore[operator]
    _assert_invalid(_validator(), payload)


@pytest.mark.parametrize("key", ["a" * 31, "a" * 65, "a" * 32 + "+", "a" * 31 + "="])
def test_ingress_requires_a_separate_bounded_base64url_idempotency_key(key: str) -> None:
    assert IDEMPOTENCY_KEY_PATTERN.fullmatch(key) is None


@pytest.mark.parametrize("key", ["a" * 32, "_" * 64])
def test_ingress_accepts_base64url_idempotency_key_boundary_lengths(key: str) -> None:
    assert IDEMPOTENCY_KEY_PATTERN.fullmatch(key) is not None


def test_idempotency_key_is_rejected_if_it_enters_the_json_envelope() -> None:
    payload = copy.deepcopy(_payload())
    payload["Idempotency-Key"] = "a" * 32
    _assert_invalid(_validator(), payload)


def test_ingress_digest_fixture_detects_envelope_drift() -> None:
    expected = (ROOT / "schemas" / "commons-evidence-envelope-v1.sha256").read_text().strip()
    actual = hashlib.sha256((ROOT / "schemas" / "commons-evidence-envelope-v1.json").read_bytes())
    assert actual.hexdigest() == expected
