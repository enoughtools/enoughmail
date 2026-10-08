# Internal malware scanner

This is a real ClamAV scanning service hosted in a Cloudflare Container, reached through a private Worker service binding. It is not an external scanning provider. Raw MIME streams into ClamD through its Unix socket; the application does not write mail to persistent disk. Engine extraction may use temporary files inside the Container, which ClamAV removes after scanning. Mail authority and quarantine receipts remain in Mail's R2 and account Durable Objects.

Deploy from the repository root:

```sh
npx wrangler deploy --config apps/mail/scanner.wrangler.json
```

Bind Mail's `MAIL_SCANNER` service to `enough-mail-scanner`. Both public Worker hostnames are disabled; no public route is configured. This service has no user-facing authorization surface. Only Mail's private service binding may call it. `GET /health` reports engine readiness and the loaded signature version; `POST /scan` accepts raw MIME with `Content-Length` and `X-Mail-SHA256`. The response echoes the actual-byte SHA-256 and actual size, supplies the loaded engine/signature version and scan limits, and reports a complete clean/infected verdict. Non-200 results never release attachments.

The raw MIME input bound is 64 MiB, including base64 encoding and headers. Decoded MIME leaves and individual archive members remain bounded to 25 MiB; total archive expansion is bounded to 100 MiB, depth five and 1,000 files. ClamAV's internal total scan budget is 164 MiB because it counts the encoded original as well as decoded/extracted data; the independent preflight enforces the 100 MiB expansion bound. Both engine scanning and preflight have ten-second limits. The independent MIME/archive preflight handles ZIP, gzip, bzip2, xz and tar. It rejects encrypted archives, unsupported RAR/7z/disk images, invalid archive claims, oversized members and malformed MIME. This matters because the real-engine smoke test found ClamAV can silently skip oversized ZIP members even with `AlertExceedsMax`. Incomplete scans remain unavailable. One active scan per Container bounds overload; concurrent requests receive 429 and are retried from durable quarantine. The container uses a five-minute inactivity timeout to allow signature-loading cold starts to complete. The caller has a bounded 45-second timeout. A cold start or a stale signature database remains unavailable while Mail retains the bytes and retries later. Freshclam notifies ClamD to reload after updates, with a 60-second self-check fallback. A signature reload during a scan invalidates its receipt for retry.

The Worker forwards real R2 bodies with backpressure, an incremental SHA-256 digest and an actual-byte count. A trusted persisted hash permits one R2 pass; otherwise the Worker hashes one stream then reopens R2 to forward a second stream. It never tees or buffers large mail. Cloudflare's `FixedLengthStream` preserves exact HTTP framing to the Container. Legacy storage adapters without a stream are allowed a buffered fallback only up to one MiB. [Workers streaming guidance](https://developers.cloudflare.com/workers/runtime-apis/streams/), [Workers request framing](https://developers.cloudflare.com/workers/runtime-apis/request/), [Workers crypto support](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/).

The official ClamAV feature-release image contains signatures. Freshclam refreshes only signature data; loaded signatures older than 72 hours fail readiness. Signature refreshes contact ClamAV's official distribution service and never upload mail. A cold restart begins from the image's bundled database, so keep image builds current; no persistent filesystem snapshot containing mail is taken. The pinned deployment artifact is the image digest built by Wrangler. Update the base image regularly for engine, operating-system and signature updates. [Official ClamAV Docker guidance](https://docs.clamav.net/manual/Installing/Docker.html), [ClamD protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html), [Cloudflare Container lifecycle API](https://developers.cloudflare.com/containers/api/durable-object-container/).

The configured custom instance provides 3 GiB memory, 1 vCPU and 4,000 MB disk. It meets Cloudflare's minimum custom size of one vCPU and three GiB per vCPU. Before shared allowances, provisioned memory plus disk costs about $0.028008 per running hour, compared with $0.038016 for `standard-1` (4 GiB, 0.5 vCPU, 8 GB). CPU bills actual usage; the higher CPU limit does not itself double CPU charges for a fixed workload. Use the shared [operating cost model](../../../docs/specs/mail/operating-cost.md), including image loading, signature refresh and inactivity grace time. This is a scale-to-zero service with billed running time; it is not zero-cost serverless scanning. [Cloudflare instance constraints](https://developers.cloudflare.com/containers/platform/limits/), [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/).

The October 5 local Docker validation under 3 GiB / one CPU passed fresh-signature readiness, clean MIME, a base64 EICAR attachment, a 101 MiB archive expansion rejection and a digest mismatch rejection. The cgroup memory peak was 1,312,276,480 bytes (about 1.22 GiB), with about 1,009 MiB steady usage. Cold start plus the complete smoke sequence took 19.82 seconds in this run. Wrangler validated the custom configuration and built its image. These observations establish headroom for the tested workload; production signature growth, more complex formats and Cloudflare cold-start latency still need measurement. ClamAV's general recommendation remains 4 GB for full signatures. Increase the configured memory if those measurements require it. [ClamAV memory guidance](https://docs.clamav.net/manual/Installing/Docker.html#image-selection-recommendations).

Reproduce real engine validation:

```sh
docker build --platform linux/amd64 -t enough-mail-scanner:test apps/mail/scanner
docker run -d --platform linux/amd64 --memory=3g --cpus=1 --name enough-mail-scanner-proof -p 127.0.0.1:18080:8080 enough-mail-scanner:test
python3 apps/mail/scanner/smoke.py
python3 -m unittest discover -s apps/mail/scanner -p 'test_*.py'
docker stats --no-stream enough-mail-scanner-proof
docker rm -f enough-mail-scanner-proof
```

The smoke test uses the harmless standard EICAR antivirus test string inside a base64 MIME attachment, a clean MIME message, an archive exceeding the extraction limit, and a mismatched digest. It requires a real ClamD process with fresh signatures. A local successful test does not prove production Container cold-start latency, signature download availability or deployment credentials.
