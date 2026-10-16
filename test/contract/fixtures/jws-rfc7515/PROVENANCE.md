# Provenance

`vectors.json` holds two examples transcribed from the IETF RFCs:

- `hs256` — RFC 7515 (JSON Web Signature), Appendix A.1 "Example JWS Using
  HMAC SHA-256": the JWS Compact Serialization, the HMAC key (the JWK `k`
  member, base64url) and the JWS Payload's claims. The same token is the
  example of RFC 7519 (JSON Web Token) §3.1.
- `unsecured` — RFC 7515 Appendix A.5 "Example Unsecured JWS" (header
  `{"alg":"none"}`, the A.1 payload, an empty signature), also RFC 7519 §6.1.

Source: https://www.rfc-editor.org/rfc/rfc7515 and
https://www.rfc-editor.org/rfc/rfc7519 (both published May 2015; RFCs are
immutable). The `hs256` signature was re-derived with HMAC-SHA256 over the
signing input and the key, and equals the RFC's.
