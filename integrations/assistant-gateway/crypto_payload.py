#!/usr/bin/env python3
"""Small authenticated envelope used only for assistant conversation payloads."""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
from pathlib import Path


def _b64(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode("ascii").rstrip("=")


def _unb64(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def read_key(path: Path) -> bytes:
    key = path.read_bytes().strip()
    if len(key) < 32:
        raise ValueError("conversation_payload_key_too_short")
    return key


def _stream(key: bytes, nonce: bytes, length: int) -> bytes:
    chunks = []
    counter = 0
    while sum(map(len, chunks)) < length:
        chunks.append(hmac.new(key, nonce + counter.to_bytes(8, "big"), hashlib.sha256).digest())
        counter += 1
    return b"".join(chunks)[:length]


def seal_text(text: str, key: bytes) -> str:
    raw = text.encode("utf-8")
    nonce = secrets.token_bytes(16)
    enc_key = hmac.new(key, b"assistant-conversation:enc:v1", hashlib.sha256).digest()
    mac_key = hmac.new(key, b"assistant-conversation:mac:v1", hashlib.sha256).digest()
    cipher = bytes(a ^ b for a, b in zip(raw, _stream(enc_key, nonce, len(raw))))
    tag = hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest()
    return f"v1.{_b64(nonce)}.{_b64(cipher)}.{_b64(tag)}"


def open_text(payload: str, key: bytes) -> str:
    try:
        version, nonce_text, cipher_text, tag_text = payload.split(".")
        if version != "v1":
            raise ValueError
        nonce, cipher, tag = _unb64(nonce_text), _unb64(cipher_text), _unb64(tag_text)
    except Exception as error:
        raise ValueError("conversation_payload_invalid") from error
    mac_key = hmac.new(key, b"assistant-conversation:mac:v1", hashlib.sha256).digest()
    expected = hmac.new(mac_key, nonce + cipher, hashlib.sha256).digest()
    if not hmac.compare_digest(tag, expected):
        raise ValueError("conversation_payload_auth_failed")
    enc_key = hmac.new(key, b"assistant-conversation:enc:v1", hashlib.sha256).digest()
    raw = bytes(a ^ b for a, b in zip(cipher, _stream(enc_key, nonce, len(cipher))))
    return raw.decode("utf-8")
