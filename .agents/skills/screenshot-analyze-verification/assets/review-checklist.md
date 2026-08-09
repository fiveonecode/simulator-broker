# Screenshot Review Checklist

Mark every line `PASS` or `FAIL`.
Any `FAIL` means the scenario is `NOT VERIFIED`.

## Context Fidelity

- [ ] Correct app
- [ ] Correct route or screen
- [ ] Correct scenario or state label
- [ ] Correct simulator and OS for the captured file

## Required Element Presence

- [ ] Target element is present and fully visible
- [ ] Bubble or callout is present
- [ ] Arrow or tail is visible and complete
- [ ] All required controls are present

## Suppression and Spotlight Behavior

- [ ] Non-target UI is dimmed or subdued evenly
- [ ] Highlight aperture is tightly scoped to the target
- [ ] Persistent chrome is subdued unless intentionally targeted
- [ ] Visual state matches the expected interaction semantics

## Copy and Legibility

- [ ] Primary copy is readable at first glance
- [ ] Secondary copy is readable when required
- [ ] No important text is truncated or clipped
- [ ] Contrast is acceptable for every required theme

## Layout and Geometry

- [ ] No overlap with critical nearby UI
- [ ] Bubble padding feels intentional and even
- [ ] Long copy wraps inside bounds
- [ ] Safe areas do not clip the bubble or tail

## Pointer Correctness

- [ ] Tail remains attached to the bubble body
- [ ] Tail tip points to the intended target anchor
- [ ] Clamping does not mis-target the pointer

## Coverage

- [ ] All requested simulators and OS versions are included
- [ ] All requested themes are included
- [ ] No simulator-specific or theme-specific regression appears in the bundle
