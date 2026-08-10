# Broke — releases

Built `.ipa` files for **Broke**, published as a [SideStore](https://sidestore.io)
source so the app can be installed and updated from the phone, with no computer.

The app's source code is **not** here — it lives in a private repository. This
repo holds only the built binary and the manifest SideStore reads. The binary
contains no secrets: Broke runs entirely on-device, with no backend and no API
keys.

## Add the source

In SideStore → **Sources** → **+**, paste:

```
https://raw.githubusercontent.com/12shamali12/broke-releases/main/apps.json
```

Updates then appear in SideStore like any other app: one tap, no cable.

## What Broke is

A personal finance app that keeps everything on the phone — wallets,
transactions, goals, debts and bills, in a local database. It works with no
internet at all. The only thing that needs a connection is SideStore's 7-day
signature renewal, which is Apple's rule for free developer accounts, not the
app's.
