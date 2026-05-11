# Brand resources

Drop your app icon here as `logo.png` and `npm run assets:generate`
from the project root will regenerate every Android icon density,
the adaptive-icon foreground, and the splash-screen images.

## Required file

| File | Size | Notes |
|------|------|-------|
| `logo.png` | 1024×1024 minimum | Centered logo on a transparent background. The bg color is added by the generator (currently `#000000`, configured in `package.json`'s `assets:generate` script). Keep ~20% safe-area padding around the logo so adaptive-icon masking (circle / squircle / rounded-rect) doesn't crop it. |

That's the only required file. The generator handles every other
density and orientation.

## Optional file

| File | Size | Notes |
|------|------|-------|
| `logo-dark.png` | 1024×1024 | Dark-mode variant if your logo needs different colors against the dark splash. Same shape rules. |

## Regenerating

After dropping `logo.png` in:

```bash
npm run assets:generate          # rewrites android/app/src/main/res/mipmap-* + drawable-*
npm run build:capacitor          # bakes the new assets into the APK
npm run build:android:release    # signs the release APK
```

The `assets:generate` script is pinned to a black background for
both icon and splash (light + dark). If you want a different color
later, edit the `--iconBackgroundColor` / `--splashBackgroundColor`
flags in `package.json`.

## What gets regenerated

Running `assets:generate` overwrites all of:

```
android/app/src/main/res/mipmap-*dpi/ic_launcher.png
android/app/src/main/res/mipmap-*dpi/ic_launcher_foreground.png
android/app/src/main/res/mipmap-*dpi/ic_launcher_round.png
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml
android/app/src/main/res/mipmap-anydpi-v26/ic_launcher_round.xml
android/app/src/main/res/drawable-*-*dpi/splash.png
android/app/src/main/res/drawable/splash.png
```

It does NOT touch `values/colors.xml`, `values/styles.xml`, or
`values/ic_launcher_background.xml` — those are hand-tuned for the
black splash theme and stay put.
