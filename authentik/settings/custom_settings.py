# =============================================================================
# authentik custom Django settings override
# =============================================================================
# This file is mounted at /authentik/root/custom_settings.py inside the
# authentik-server container.
# DJANGO_SETTINGS_MODULE is set to authentik.root.custom_settings.
#
# PURPOSE: Enable USE_X_FORWARDED_HOST so Django's build_absolute_uri()
# reads from X-Forwarded-Host header (set to auth.localhost:8000 by the
# Traefik authentik-headers middleware).
#
# This ensures the OIDC issuer URL = http://auth.localhost:8000/... even
# when curl sends Host: auth.localhost (no port).
# CONTRACT §0 compliance.
# =============================================================================
from authentik.root.settings import *  # noqa

# Use the X-Forwarded-Host header for URL building.
# The Traefik authentik-headers middleware sets:
#   X-Forwarded-Host: auth.localhost:8000
# This makes Django's build_absolute_uri() return the correct port.
USE_X_FORWARDED_HOST = True
