# GigaChat CA certificates

GigaChat API may require the Russian Ministry of Digital Development trust chain.

Do not disable TLS verification in production. Download the official root/intermediate certificates from the official source, combine PEM certificates into `gigachat-ca.pem`, and set in `.env`:

```env
NODE_EXTRA_CA_CERTS=/app/certs/gigachat-ca.pem
```

Because Dockerfile copies the project into `/app`, the file will be available to Node after rebuilding the image.
