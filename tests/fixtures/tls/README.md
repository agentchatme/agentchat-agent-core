A self-signed certificate for `localhost` / `127.0.0.1`, for tests only
(`tests/served-manual.test.ts` serves a real multi-hop HTTPS redirect chain on
loopback with it). The key is not a secret: it signs nothing but this test
certificate, which nothing trusts outside the test that passes it as `ca`.

Regenerate: `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" -keyout localhost.key -out localhost.crt`
