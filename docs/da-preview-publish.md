# DA (Document Authoring) Preview & Publish — Reference

## Architecture Overview

This project uses **Document Authoring (DA)** as the content source for AEM Edge Delivery Services.
Content flows through three layers:

```
DA Content Source          AEM Admin API              AEM CDN
(admin.da.live)            (admin.hlx.page)           (.aem.page / .aem.live)

  Source HTML   ──────►    Preview / Publish   ──────►   Public delivery
  (auth required)          (relays IMS token            (no auth)
                            to content source)
```

### Key Endpoints

| Purpose | Endpoint | Auth |
|---------|----------|------|
| DA content CRUD | `https://admin.da.live/source/{org}/{repo}/{path}.html` | `Authorization: Bearer <DA_TOKEN>` |
| DA content listing | `https://admin.da.live/list/{org}/{repo}/{path}` | `Authorization: Bearer <DA_TOKEN>` |
| AEM preview trigger | `POST https://admin.hlx.page/preview/{org}/{repo}/{ref}/{path}` | `Authorization: Bearer <DA_TOKEN>` |
| AEM publish trigger | `POST https://admin.hlx.page/live/{org}/{repo}/{ref}/{path}` | Same as preview |
| AEM status check | `GET https://admin.hlx.page/status/{org}/{repo}/{ref}/{path}` | None (public) |
| Preview delivery | `https://{ref}--{repo}--{org}.aem.page/{path}` | None |
| Live delivery | `https://{ref}--{repo}--{org}.aem.live/{path}` | None |

### This Project's Values

- **org**: `carlossg`
- **repo**: `arco`
- **ref**: `main`
- **DA content URL**: `https://content.da.live/carlossg/arco/`
- **fstab type**: `markup` (DA serves pre-rendered HTML, not markdown)

## Authentication

The DA token (stored in `.env` as `DA_TOKEN`) works for both DA APIs and the AEM Admin API:

- **DA APIs** (`admin.da.live`, `content.da.live`): `Authorization: Bearer $DA_TOKEN`
- **AEM Admin API** (`admin.hlx.page`): `Authorization: Bearer $DA_TOKEN`

> **Note**: The `x-auth-token` header does NOT work with DA tokens for the admin API. Always use `Authorization: Bearer`.

### Token Details

- Obtained by logging in via Adobe IMS at [da.live](https://da.live)
- **24-hour expiry** (`expires_in: 86400000` ms)
- Stored in `.env` as `DA_TOKEN`

### Checking Token Expiry

```bash
echo "$DA_TOKEN" | cut -d. -f2 | python3 -c "
import sys, base64, json, datetime
payload = sys.stdin.read().strip()
payload += '=' * (4 - len(payload) % 4)
decoded = json.loads(base64.urlsafe_b64decode(payload))
created = int(decoded.get('created_at', 0)) / 1000
expires_in = int(decoded.get('expires_in', 0)) / 1000
expires = created + expires_in
now = datetime.datetime.now().timestamp()
print(f'Client: {decoded.get(\"client_id\")}')
print(f'Expires: {datetime.datetime.fromtimestamp(expires)}')
print(f'Expired: {now > expires}')
"
```

### Getting a Fresh DA Token

1. Open [da.live](https://da.live) in a browser and sign in with Adobe credentials
2. Open browser DevTools > Application > Cookies or Network tab
3. Copy the IMS access token
4. Update `.env` with the new `DA_TOKEN=...`

## Preview & Publish via curl

### Single Page

```bash
# Preview
curl -X POST "https://admin.hlx.page/preview/carlossg/arco/main/{path}" \
  -H "Authorization: Bearer $DA_TOKEN"

# Publish
curl -X POST "https://admin.hlx.page/live/carlossg/arco/main/{path}" \
  -H "Authorization: Bearer $DA_TOKEN"

# Verify
curl -s -o /dev/null -w "%{http_code}" "https://main--arco--carlossg.aem.page/{path}"
```

### Bulk Preview/Publish (all DA pages)

List all pages in DA recursively, then preview and publish each one:

```bash
export $(grep -v '^#' .env | xargs)

# List all pages
python3 -c "
import json, subprocess, os
DA_TOKEN = os.environ['DA_TOKEN']
BASE = 'https://admin.da.live/list/carlossg/arco'
def list_da(path=''):
    r = subprocess.run(['curl','-s',f'{BASE}{path}','-H',f'Authorization: Bearer {DA_TOKEN}'],capture_output=True,text=True)
    try: return json.loads(r.stdout)
    except: return []
pages = []
def crawl(path=''):
    for item in list_da(path):
        p = item['path'].replace('/carlossg/arco','')
        if p.endswith('.html'): pages.append(p.replace('.html',''))
        elif 'ext' not in item and item['name'] != 'media': crawl(p)
crawl()
for p in sorted(pages): print(p)
"

# Preview and publish all pages
for page in $(python3 -c "...same script..."); do
  curl -s -o /dev/null -w "Preview %{http_code}: $page\n" -X POST \
    "https://admin.hlx.page/preview/carlossg/arco/main$page" \
    -H "Authorization: Bearer $DA_TOKEN"
  curl -s -o /dev/null -w "Publish %{http_code}: $page\n" -X POST \
    "https://admin.hlx.page/live/carlossg/arco/main$page" \
    -H "Authorization: Bearer $DA_TOKEN"
  sleep 0.3
done
```

### Editing DA Content via API

```bash
# Read
curl -s "https://admin.da.live/source/carlossg/arco/{path}.html" \
  -H "Authorization: Bearer $DA_TOKEN"

# Write (multipart form upload)
curl -X PUT "https://admin.da.live/source/carlossg/arco/{path}.html" \
  -H "Authorization: Bearer $DA_TOKEN" \
  -F "data=@/path/to/file.html;type=text/html"
```

## Diagnosing "Page Not Displaying"

When a page returns 404 on `.aem.page`:

1. **Check AEM status**: `curl -s "https://admin.hlx.page/status/carlossg/arco/main/{path}" | python3 -m json.tool`
2. **Check DA content exists**: `curl -s "https://admin.da.live/source/carlossg/arco/{path}.html" -H "Authorization: Bearer $DA_TOKEN"`
3. **Trigger preview**: `curl -X POST "https://admin.hlx.page/preview/carlossg/arco/main/{path}" -H "Authorization: Bearer $DA_TOKEN"`
4. **Verify**: `curl -s -o /dev/null -w "%{http_code}" "https://main--arco--carlossg.aem.page/{path}"`

## Common Issues

### Header/Footer Not Displaying

The header loads `/nav.plain.html` as a fragment; the footer loads `/footer.plain.html`. If these haven't been previewed, they return 404 and render empty. Fix: preview both `/nav` and `/footer`.

### Index Pages Require Trailing Slash

`/stories` returns 404 but `/stories/` returns 200. AEM Edge Delivery does not auto-redirect. Navigation links to index pages must include the trailing slash.

### Pages Exist in DA But 404 on aem.page

Content in DA is not automatically available on `.aem.page`. Each page must be explicitly **previewed** (and **published** for `.aem.live`) via the AEM Admin API.

### DA_REPO Mismatch

The `services/recommender/.env` file has `DA_REPO` used by the recommender's `AEMAdminClient`. Ensure it matches the actual repository name (`arco`).

## Programmatic Preview/Publish (Backend)

The recommender service has a `persistAndPublish` function in `services/recommender/src/lib/da-client.ts` that:

1. Creates a page in DA via `DAClient.createPage()`
2. Triggers preview via `AEMAdminClient.preview()`
3. Waits for preview availability via `AEMAdminClient.waitForPreview()`
4. Publishes to live via `AEMAdminClient.publish()`
5. Purges CDN cache via `AEMAdminClient.purgeCache()`

## Reference Links

- [AEM Admin API docs](https://www.aem.live/docs/admin.html)
- [DA developer docs](https://docs.da.live/developers)
- [Auth setup for authors](https://www.aem.live/docs/authentication-setup-authoring)
- [DA permissions guide](https://docs.da.live/administrators/guides/permissions)
- [Config service setup](https://www.aem.live/docs/config-service-setup)
- [DA tutorial](https://www.aem.live/developer/da-tutorial)
