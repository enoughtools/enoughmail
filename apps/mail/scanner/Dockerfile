# Feature release tag receives security patches; Cloudflare pins the built image digest.
FROM clamav/clamav:1.4
USER root
RUN apk add --no-cache python3 && mkdir -p /opt/mail-scanner /run/clamav && chown clamav:clamav /run/clamav /var/lib/clamav
COPY clamd.conf /etc/clamav/clamd.conf
COPY server.py /opt/mail-scanner/server.py
COPY preflight.py /opt/mail-scanner/preflight.py
COPY entrypoint.sh /opt/mail-scanner/entrypoint.sh
RUN chmod 755 /opt/mail-scanner/entrypoint.sh && chown -R clamav:clamav /opt/mail-scanner
ENV TZ=UTC
EXPOSE 8080
USER clamav
ENTRYPOINT ["/opt/mail-scanner/entrypoint.sh"]
