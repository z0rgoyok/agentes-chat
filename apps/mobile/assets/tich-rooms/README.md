# Tich Rooms iOS icon

Owner-approved artwork: a human and an AI agent meeting in a cobalt-blue glass room with warm orange light.

`icon-source.png` is the original generated artwork approved on 2026-11-24. Export the opaque App Store image reproducibly:

```sh
sips -z 1024 1024 apps/mobile/assets/tich-rooms/icon-source.png --out apps/mobile/assets/tich-rooms/icon.png
```

The iOS light and dark primary icon and its in-app preview use this asset. The native primary-icon identifier remains unchanged so existing preferences continue to work. Alternate icons remain available. This managed-fork branding must not enter upstream pull requests.
