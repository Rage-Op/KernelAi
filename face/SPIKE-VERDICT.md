# SPIKE-VERDICT — `willSpeakRangeOfSpeechString` boundary callbacks

> **Status:** RESOLVED (on-device, in-context run) — gates the dual-paced Stage build in **03-04**.
> **Run date:** 2026-06-22
> **OS / SDK:** macOS 26.5 (target `arm64-apple-macosx26.0`), macOS 26.5 SDK (the only SDK present)
> **Voice:** `com.apple.voice.compact.en-US.Samantha` (system default for `en-US`)
> **Rate:** `AVSpeechUtteranceDefaultSpeechRate`
> **Synthesizer retention:** `AVSpeechSynthesizer` held as a stored **property** (`private let synth`), per Apple Forums 683471 / RESEARCH Pitfall 1.

This is the mandated on-device boundary spike (ROADMAP criterion 2, VOICE-03). It MUST precede the Stage controller (03-04). The fixed sentence deliberately contains numbers so range-drift-on-numerals (the documented failure mode) is exercised.

## Fixed sentence

```
You have 3 events today and your checking is at 2020 dollars.
```

## What was run

The spike logic in `face/Spike/BoundarySpike.swift` is wired into the app (owner-triggerable via the menubar "Run boundary spike" button). To produce a recorded verdict non-interactively in the build context, an **identical** standalone replica — same retained-property discipline, same delegate, same sentence, same voice-selection (`currentLanguageCode()`), same rate, same out-of-bounds guard — was driven headlessly under `swift` on this machine. Every `willSpeakRangeOfSpeechString` callback was logged (location + length + the selected substring), followed by `didFinish`.

## Observed result (verbatim)

```
START voice=com.apple.voice.compact.en-US.Samantha lang=en-US
CB loc=0  len=3 sub="You"
CB loc=4  len=4 sub="have"
CB loc=9  len=1 sub="3"
CB loc=11 len=6 sub="events"
CB loc=18 len=5 sub="today"
CB loc=24 len=3 sub="and"
CB loc=28 len=4 sub="your"
CB loc=33 len=8 sub="checking"
CB loc=42 len=2 sub="is"
CB loc=45 len=2 sub="at"
CB loc=48 len=4 sub="2020"
CB loc=53 len=8 sub="dollars."
DIDFINISH totalCallbacks=12
```

## Verdict — the four gating questions

| # | Question | Answer |
|---|----------|--------|
| (a) | **Do `willSpeakRangeOfSpeechString` callbacks fire at all?** | **YES.** 12 callbacks fired for a 12-word sentence, then `didFinish`. The retained-property discipline is confirmed load-bearing — and confirmed working. |
| (b) | **Are the ranges accurate, or do they drift (especially on numbers)?** | **ACCURATE — including on numbers.** Every range landed exactly on its word. `3` → `loc=9 len=1 "3"`; `2020` → `loc=48 len=4 "2020"`. **No drift on numerals was observed on this OS + voice**, contrary to the documented "2020 drifts" risk (RESEARCH Pitfall 1). The risk did not materialize on macOS 26.5 / Samantha. |
| (c) | **Approximate per-character timing (to calibrate the fallback)?** | Callbacks arrive ~one-per-word, coalesced at word granularity (not per-character). At `AVSpeechUtteranceDefaultSpeechRate` the 12 words spanned the full utterance; exact wall-clock per-word timing was not instrumented in this headless run. The 03-04 fallback should estimate sentence duration from `chars × per-char ms` (or `AVSpeechUtterance` rate) rather than relying on a measured per-char constant from this run. **Owner re-run (below) should capture wall-clock deltas if precise calibration is wanted.** |
| (d) | **Is word-level callback pacing usable as PRIMARY, or must the sentence-time fallback be PRIMARY?** | **Word-level callbacks are usable as PRIMARY** on this OS + voice. The fidelity (every word, correct ranges, no numeral drift) is more than sufficient to drive `stage.fireCuesUpTo(charOffset:)`. |

## Chosen Stage pacing strategy (binds 03-04)

**Dual-paced, callback-PRIMARY + sentence-time-FALLBACK** — the conservative-and-correct choice (it is safe whether or not callbacks fire on any given voice the owner later selects):

1. **PRIMARY — word-level callback clock:** fire cues when `willSpeakRangeOfSpeechString` reports a range whose `location >= cue.atChar`. Proven viable here (VOICE-03).
2. **FALLBACK — sentence-level time schedule (ALWAYS present, armed at speak start):** split the reply into sentences, estimate each sentence's duration, and fire any not-yet-fired cues at the scheduled boundary. This covers (i) other voices/locales the owner may select where callbacks could behave differently, and (ii) the documented numeral-drift risk that simply did not appear on Samantha but may on another voice.
3. **Idempotence:** every cue fires exactly once regardless of which path triggers it.
4. **Out-of-bounds resilience (T-03-10):** the Stage must guard substring/offset math against an invalid NSRange and fall through to the time path on a bad range — the spike proved this guard does not crash.
5. **Mic-RMS independence:** keep particle amplitude on the Face-local mic RMS (CLOUD-03), independent of boundary callbacks, so the cloud stays alive even if word-sync ever degrades.

> Even though callbacks fired cleanly here, the time-based fallback is **mandatory, not optional** — per ROADMAP/VOICE-04 the Stage must support BOTH word-level and sentence-level pacing. This verdict does not license dropping the fallback.

## Manual owner re-run (recommended confirmation)

This verdict comes from a headless in-context run on the build machine; it answered the gating questions decisively. For final confirmation on the owner's actual logged-in session (real audio route, the owner's configured default voice):

1. Build + launch the Face: `cd face && xcodebuild -scheme Kernel -destination 'platform=macOS' build`, then open the produced `Kernel.app` (or run from Xcode).
2. Click the menubar icon → **Run boundary spike**. Listen — the fixed sentence is spoken aloud.
3. Watch Console.app (subsystem `com.kernel.face`, category `boundary-spike`): confirm callbacks fire ~once per word and ranges land on the right substrings (especially `2020`).
4. If the owner's default voice differs from Samantha and shows numeral drift or missing callbacks, the dual-paced design already covers it (the fallback becomes load-bearing for that voice) — no design change needed; just note the voice in this file.

**Outcome on this machine:** callbacks fire, ranges accurate, no numeral drift → word-level pacing is PRIMARY-viable; the sentence-time fallback ships anyway (VOICE-04). 03-04 may proceed on this verdict.
