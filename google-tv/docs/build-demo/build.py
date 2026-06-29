#!/usr/bin/env python3
"""
Assemble the Arco-on-Google-TV demo: intro slide -> Acts 1-3 (narrated screen
recording) -> outro slide. Re-encodes everything to a uniform format and concats.

Incremental: skips segments that already exist. Delete a segment (and the final
mp4) to force a rebuild of that piece.

No background music asset was provided, so intro/outro are silent holds.
"""
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "source.mp4")
OUT = os.path.join(HERE, "arco-tv-demo.mp4")

W, H, FPS = 1920, 1080, 25
VENC = ["-c:v", "libx264", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p", "-r", str(FPS)]
AENC = ["-c:a", "aac", "-ac", "2", "-b:a", "192k"]
SCALEPAD = f"scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2,setsar=1"

# Per-act source cut [start, end] (seconds) and the VO file.
# Freeze-frame padding extends each clip to its narration length.
ACTS = [
    {"name": "act1", "ss": 1.0,  "to": 6.5},   # TV home (clean, before overlay fires ~9s)
    {"name": "act2", "ss": 9.0,  "to": 12.0},  # "OK Google" overlay
    {"name": "act3", "ss": 17.2, "to": 20.0},  # clean 3-card result
]

INTRO_HOLD = 4.0   # seconds
OUTRO_HOLD = 5.0   # seconds


def run(cmd):
    print("+", " ".join(str(c) for c in cmd))
    subprocess.run(cmd, check=True)


def dur(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", path],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())


def build_slide(image, seconds, out_path):
    """Silent slide segment from a still image."""
    if os.path.exists(out_path):
        print("skip", out_path)
        return
    run(["ffmpeg", "-y", "-loglevel", "error",
         "-loop", "1", "-t", f"{seconds}", "-i", image,
         "-f", "lavfi", "-t", f"{seconds}", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
         "-vf", f"{SCALEPAD},format=yuv420p",
         *VENC, *AENC, "-shortest", out_path])


def build_act(act, out_path):
    """Cut source clip, overlay VO, freeze-pad video to VO length."""
    if os.path.exists(out_path):
        print("skip", out_path)
        return
    vo = os.path.join(HERE, "audio", f"{act['name']}.mp3")
    vo_len = dur(vo)
    clip_len = act["to"] - act["ss"]
    # video must last VO + 300ms lead-in; pad the difference by freezing last frame
    target = vo_len + 0.4
    pad = max(0.0, target - clip_len)

    vfilter = f"{SCALEPAD},tpad=stop_mode=clone:stop_duration={pad:.3f},format=yuv420p"
    afilter = (f"[1:a]adelay=300|300,aresample=async=1,"
               f"apad=pad_dur={target:.3f},pan=stereo|c0=c0|c1=c0[aout]")

    run(["ffmpeg", "-y", "-loglevel", "error",
         "-ss", f"{act['ss']}", "-to", f"{act['to']}", "-i", SRC,
         "-i", vo,
         "-filter_complex", f"[0:v]{vfilter}[vout];{afilter}",
         "-map", "[vout]", "-map", "[aout]",
         "-t", f"{target:.3f}",
         *VENC, *AENC, out_path])


def main():
    seg = os.path.join(HERE, "segments")
    os.makedirs(seg, exist_ok=True)

    # regenerate slides
    run([os.path.join(HERE, "..", ".demovenv", "bin", "python"),
         os.path.join(HERE, "make_slides.py")])

    order = []

    intro = os.path.join(seg, "00-intro.mp4")
    build_slide(os.path.join(HERE, "images", "intro.png"), INTRO_HOLD, intro)
    order.append(intro)

    for i, act in enumerate(ACTS, start=1):
        p = os.path.join(seg, f"{i:02d}-{act['name']}.mp4")
        build_act(act, p)
        order.append(p)

    outro = os.path.join(seg, "99-outro.mp4")
    build_slide(os.path.join(HERE, "images", "outro.png"), OUTRO_HOLD, outro)
    order.append(outro)

    concat = os.path.join(HERE, "concat.txt")
    with open(concat, "w") as f:
        for p in order:
            f.write(f"file '{p}'\n")

    run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", concat, *VENC, *AENC, OUT])

    print("\nFINAL:", OUT, f"({dur(OUT):.1f}s)")


if __name__ == "__main__":
    main()
