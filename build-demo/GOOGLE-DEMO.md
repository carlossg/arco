# Google Cloud demo

The latest recording is [`arco-google-cloud-demo.mp4`](./arco-google-cloud-demo.mp4):
94 seconds, 1920x1080, with selectable English captions and six chapters.
It is a silent screen recording, not a narrated video.

Run from the repository root:

```sh
bun build-demo/record-google-demo.mjs
```

Requires the existing Playwright dependency and browser, plus `ffmpeg` and
`ffprobe`. Defaults to the deployed Google-backed feature preview, not main or
localhost. Override `BASE_URL`, `API_URL`, or `OUTPUT_DIR` as needed; set
`HEADED=1` to show the browser during recording.

The recording follows the original walkthrough with an updated final act:

1. Browse the Arco homepage.
2. Visit Espresso Anywhere and collect real browsing signals.
3. Read the Travel Espresso Guide to build related session context.
4. Click For You and wait for actual Google-backed personalized generation.
5. Type a camping espresso query and show its streamed recommendations.
6. Publish those generated blocks through `/api/persist`, open the saved page
   on the feature preview, and reload it.

Publishing is performed by the recorder through the real API, not an invented
site button. This creates a unique, permanently published
`/discover/google-video-{id}` page and requires the runtime's valid Adobe
credential. It does not overwrite authored pages. The final reload demonstrates
delivery of saved content, **not** an instant-cache claim for the query endpoint.

Outputs are placed under the ignored `build-demo/recordings/google-{timestamp}/`:

- `arco-google-cloud-demo.mp4`: 1920x1080 H.264 screen recording with chapter
  metadata and an embedded selectable English subtitle track; no voiceover.
- `demo.vtt`: the same timed walkthrough captions as a standalone subtitle file.
- `report.json`: actual chapter timings, generated URLs, published URLs and
  network/error checks.
- `published-page.png`: a full-page screenshot.
- The original Playwright WebM and FFmpeg chapter metadata.

The recorder requires complete, error-free NDJSON generation, actual decorated
sections, a successfully published page and a loaded hero image. Cloudflare
requests are blocked and any attempted request fails the recording. Browser
page errors also fail the run; incomplete walkthroughs are not reported as
successful.

The older `arco-demo.mp4`, `record-demo.mjs`, and narrated `build.py` are unchanged.
