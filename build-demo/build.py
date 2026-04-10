#!/usr/bin/env python3
"""Build narrated demo video from screen recording + talk track."""

import json
import os
import subprocess
import sys
from pathlib import Path

import requests
from dotenv import load_dotenv
from PIL import Image, ImageDraw, ImageFont

load_dotenv(Path(__file__).resolve().parent.parent / ".env")

# ── Config ──────────────────────────────────────────────────────────
ELEVENLABS_KEY = os.environ["ELEVENLABS_API_KEY"]
VOICE_ID = "nPczCjzI2devNBz1zQrb"  # Brian
SOURCE_VIDEO = next(Path("recordings").glob("*.webm"))
WIDTH, HEIGHT, FPS = 1920, 1080, 25

OUTRO_TITLE = "Arco Espresso"
OUTRO_SUBTITLE = "Built on AEM Edge Delivery Services"
OUTRO_BG = "#1a1a1a"

# ── Talk Track ──────────────────────────────────────────────────────
# No intro slide — starts directly on the homepage.
# For You comes BEFORE AI Search.
# Narration should be tight to minimize silence.
ACTS = [
    ("homepage", "video", 0, 6,
     "This is Arco, a specialty espresso brand running on Adobe Experience Manager "
     "Edge Delivery Services. "
     "As our user browses, the site passively collects signals to build a real-time interest profile."),

    ("espresso-anywhere", "video", 6, 16,
     "They navigate to the Espresso Anywhere experience. "
     "The signal collector picks up this interest in portable coffee gear, "
     "tracking page visits, scroll depth, and time spent."),

    ("travel-guide", "video", 16, 26,
     "Next, the Travel Espresso Guide. The system now knows this user cares about "
     "outdoor and travel-friendly coffee. All of this context is stored locally in the browser session."),

    ("for-you", "video", 26, 45,
     "Back in the navigation, a personalized For You link has appeared. "
     "Clicking it sends the browsing context to the backend, which generates "
     "a set of recommendations tailored to their travel and outdoor interests. "
     "The page streams in progressively, built entirely from the user's browsing behavior."),

    ("ai-search", "video", 45, 73,
     "Now the user goes further. They type a natural language query: "
     "I'm looking for a coffee machine to use when camping in the middle of the forest. "
     "The backend runs a hybrid RAG pipeline, combining keyword search with semantic vector search. "
     "The LLM reasons over the results and generates a fully personalized page in real time."),

    ("cache-and-close", "video", 73, 86,
     "Refreshing the page shows the caching layer in action. "
     "The same query loads instantly from the Edge Delivery cache, no AI pipeline needed. "
     "From passive signal collection to AI-powered generation to instant caching, "
     "this is Adobe Experience Manager Edge Delivery Services, powering AI-driven personalization."),

    ("outro", "slide", None, None, ""),
]

DIRS = {d: Path(d) for d in ("audio", "images", "segments")}

def run(cmd, desc=""):
    """Run ffmpeg/ffprobe command."""
    print(f"  -> {desc or cmd[:80]}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(f"  ERROR: {result.stderr[:500]}")
        sys.exit(1)
    return result.stdout

def generate_tts(text, out_path):
    """Generate TTS via ElevenLabs."""
    if out_path.exists() and out_path.stat().st_size > 0:
        print(f"  [cached] {out_path.name}")
        return
    print(f"  Generating TTS: {out_path.name}")
    resp = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
        headers={"xi-api-key": ELEVENLABS_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.6, "similarity_boost": 0.8, "style": 0.15},
        },
    )
    resp.raise_for_status()
    out_path.write_bytes(resp.content)

def get_duration(path):
    """Get media duration in seconds."""
    out = subprocess.run(
        f'ffprobe -v quiet -print_format json -show_format "{path}"',
        shell=True, capture_output=True, text=True,
    ).stdout
    return float(json.loads(out)["format"]["duration"])

def make_slide(text, subtitle, bg_color, out_path):
    """Generate a slide PNG."""
    if out_path.exists():
        print(f"  [cached] {out_path.name}")
        return
    print(f"  Creating slide: {out_path.name}")
    img = Image.new("RGB", (WIDTH, HEIGHT), bg_color)
    draw = ImageDraw.Draw(img)

    font_path = "/System/Library/Fonts/Helvetica.ttc"
    title_font = ImageFont.truetype(font_path, 72)
    sub_font = ImageFont.truetype(font_path, 36)

    bbox = draw.textbbox((0, 0), text, font=title_font)
    tw = bbox[2] - bbox[0]
    draw.text(((WIDTH - tw) / 2, HEIGHT / 2 - 80), text, fill="white", font=title_font)

    if subtitle:
        bbox = draw.textbbox((0, 0), subtitle, font=sub_font)
        sw = bbox[2] - bbox[0]
        draw.text(((WIDTH - sw) / 2, HEIGHT / 2 + 20), subtitle, fill="#aaaaaa", font=sub_font)

    img.save(out_path)

def build_slide_segment(act_name, slide_path, audio_path, out_path):
    """Build a segment from a slide image + optional audio."""
    if out_path.exists():
        print(f"  [cached] {out_path.name}")
        return

    if audio_path and audio_path.exists():
        audio_dur = get_duration(audio_path)
        total_dur = audio_dur + 1.5
        cmd = (
            f'ffmpeg -y -loop 1 -i "{slide_path}" -i "{audio_path}" '
            f'-filter_complex "'
            f'[0:v]scale={WIDTH}:{HEIGHT},fps={FPS},format=yuv420p,trim=duration={total_dur}[v];'
            f'[1:a]adelay=500|500,aresample=48000,apad=whole_dur={total_dur},pan=stereo|c0=c0|c1=c0[a]'
            f'" -map "[v]" -map "[a]" '
            f'-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k '
            f'-shortest -t {total_dur} "{out_path}"'
        )
    else:
        total_dur = 3
        cmd = (
            f'ffmpeg -y -loop 1 -i "{slide_path}" '
            f'-filter_complex "'
            f'[0:v]scale={WIDTH}:{HEIGHT},fps={FPS},format=yuv420p,trim=duration={total_dur}[v];'
            f'anullsrc=r=48000:cl=stereo[a]'
            f'" -map "[v]" -map "[a]" '
            f'-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k '
            f'-t {total_dur} "{out_path}"'
        )
    run(cmd, f"Build slide segment: {out_path.name}")

def build_video_segment(act_name, start, end, audio_path, out_path):
    """Build a segment from source video clip + voiceover."""
    if out_path.exists():
        print(f"  [cached] {out_path.name}")
        return

    clip_dur = end - start
    audio_dur = get_duration(audio_path) if audio_path and audio_path.exists() else 0
    total_dur = max(clip_dur, audio_dur + 0.3)

    tpad = ""
    if audio_dur > clip_dur:
        extra = audio_dur - clip_dur + 0.3
        tpad = f",tpad=stop_mode=clone:stop_duration={extra}"

    cmd = (
        f'ffmpeg -y -ss {start} -t {clip_dur} -i "{SOURCE_VIDEO}" -i "{audio_path}" '
        f'-filter_complex "'
        f'[0:v]scale={WIDTH}:{HEIGHT},fps={FPS},format=yuv420p{tpad}[v];'
        f'[1:a]adelay=200|200,aresample=48000,apad=whole_dur={total_dur},pan=stereo|c0=c0|c1=c0[a]'
        f'" -map "[v]" -map "[a]" '
        f'-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k '
        f'-shortest -t {total_dur} "{out_path}"'
    )
    run(cmd, f"Build video segment: {out_path.name}")

def main():
    for d in DIRS.values():
        d.mkdir(exist_ok=True)

    segments = []

    for i, (name, atype, start, end, narration) in enumerate(ACTS):
        print(f"\n{'='*60}")
        print(f"Act {i}: {name} ({atype})")
        print(f"{'='*60}")

        audio_path = DIRS["audio"] / f"act{i}-{name}.mp3"
        segment_path = DIRS["segments"] / f"{i:02d}-{name}.mp4"

        if narration:
            generate_tts(narration, audio_path)
        else:
            audio_path = None

        if atype == "slide":
            slide_path = DIRS["images"] / "outro.png"
            make_slide(OUTRO_TITLE, OUTRO_SUBTITLE, OUTRO_BG, slide_path)
            build_slide_segment(name, slide_path, audio_path, segment_path)
        else:
            build_video_segment(name, start, end, audio_path, segment_path)

        segments.append(segment_path)

    # ── Concatenate ─────────────────────────────────────────────
    print(f"\n{'='*60}")
    print("Concatenating all segments...")
    print(f"{'='*60}")

    concat_file = Path("concat.txt")
    concat_file.write_text("\n".join(f"file '{s}'" for s in segments))

    output = Path("arco-demo.mp4")
    if output.exists():
        output.unlink()

    run(
        f'ffmpeg -y -f concat -safe 0 -i "{concat_file}" '
        f'-c:v libx264 -preset fast -crf 18 -c:a aac -b:a 192k '
        f'-movflags +faststart "{output}"',
        "Final concatenation with re-encode",
    )

    dur = get_duration(output)
    size_mb = output.stat().st_size / 1024 / 1024
    print(f"\nDone! Output: {output} ({dur:.1f}s, {size_mb:.1f}MB)")

if __name__ == "__main__":
    main()
