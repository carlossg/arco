Preview and publish pages in DA (Document Authoring) to AEM Edge Delivery Services.

## Arguments

$ARGUMENTS — Optional: specific page paths to publish (e.g., `about products/espresso-machines`). If empty, publish ALL pages in DA.

## Instructions

This project uses DA as the content source. Content must be explicitly previewed and published via the AEM Admin API.

### Configuration

- **org**: `carlossg`, **repo**: `arco`, **ref**: `main`
- **DA token**: stored in `.env` as `DA_TOKEN`
- **Auth header**: `Authorization: Bearer $DA_TOKEN` (do NOT use `x-auth-token`)
- **DA list API**: `https://admin.da.live/list/carlossg/arco{path}`
- **DA source API**: `https://admin.da.live/source/carlossg/arco/{path}.html`
- **AEM preview**: `POST https://admin.hlx.page/preview/carlossg/arco/main/{path}`
- **AEM publish**: `POST https://admin.hlx.page/live/carlossg/arco/main/{path}`

### Steps

1. **Load the DA token** from `.env`:
   ```bash
   export $(grep -v '^#' .env | xargs)
   ```

2. **If specific pages were requested**, preview and publish only those pages. Otherwise, **list all pages in DA recursively** using Python:
   ```python
   # Crawl admin.da.live/list/carlossg/arco recursively
   # Collect all .html paths, strip /carlossg/arco prefix and .html suffix
   # Skip directories named "media"
   ```

3. **Preview each page** via POST to `admin.hlx.page/preview/...` with `Authorization: Bearer $DA_TOKEN`. Log the HTTP status for each.

4. **Publish each page** via POST to `admin.hlx.page/live/...` with the same auth. Log the HTTP status.

5. **Report results**: total pages, successes, failures.

### Important notes

- Index pages (e.g., `/stories/index`) are served at `/stories/` with trailing slash
- Add 300ms delay between requests to avoid rate limiting
- The DA token expires after 24 hours — if you get 401s, tell the user to refresh their token at da.live
- To edit DA content: `PUT admin.da.live/source/...` with `-F "data=@file.html;type=text/html"` (multipart form, NOT raw body)
