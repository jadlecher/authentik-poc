# =============================================================================
# authentik local settings override
# =============================================================================
# Mounted at /data/local_settings.py inside the container.
# Imported by AUTHENTIK_SETTINGS_FILE env var mechanism.
#
# PURPOSE: Set USE_X_FORWARDED_HOST=True so Django's build_absolute_uri()
# reads the host from X-Forwarded-Host header instead of the HTTP Host header.
# This is needed because Traefik → authentik-go-proxy → gunicorn strips the
# port from the Host header. We inject X-Forwarded-Host: auth.localhost:8000
# via the Traefik authentik-headers middleware, so Django must use it.
#
# CONTRACT §0 compliance: ensures issuer = http://auth.localhost:8000/...
# =============================================================================
from authentik.root.settings import *  # noqa

USE_X_FORWARDED_HOST = True
