# Deploy to Quest

Reference for the Deploy to Quest dialog in theDAW's app menu. The dialog
installs a prebuilt theDAW-XR APK onto a connected Meta Quest headset over the
Android Debug Bridge (adb). It is a deploy path only. It does not build the APK
from Unity. The APK is already compiled, and the dialog copies it onto the
headset and optionally starts it.

For the live streaming and control links between theDAW and the headset, see the
XR spatialization coverage. This guide covers the install path.

## What Deploy to Quest does

The dialog performs three steps against a headset that is plugged in and
authorized:

1. Resolve an adb executable on the machine.
2. Install the chosen APK with `adb install -r` (reinstall, keeping data).
3. Optionally launch the installed package on the headset.

The install reuses the same adb bridge the theDAW-XR companion already relies on.
No Unity editor, Android build, or Gradle step is involved.

## Prerequisites on the headset

The headset must be in developer mode with USB debugging authorized before it
appears as a deploy target.

- Enable developer mode for the Meta account that owns the headset. This is done
  in the Meta Quest mobile app under the headset's developer settings, and it
  requires a registered developer organization on the Meta account.
- Connect the headset to the machine over USB.
- Put the headset on and accept the "Allow USB debugging" prompt that appears
  inside the headset. Choosing "Always allow from this computer" avoids the
  prompt on later connections.

Until USB debugging is accepted, adb reports the device in an `unauthorized`
state and it cannot receive an install.

## Finding adb

adb is often absent from PATH on a Windows machine, so the dialog searches for it
automatically. The resolver checks these sources in priority order and uses the
first adb it finds:

1. An explicit path saved in the dialog, stored in `data/quest.json`.
2. adb on the system PATH.
3. The `QUEST_ADB_PATH` or `ADB_PATH` environment variable.
4. The Android SDK, located from `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the
   default `platform-tools` folder under the local app data and home Android SDK
   directories.
5. Unity Hub's bundled Android SDK, under any installed editor version's
   `PlaybackEngines/AndroidPlayer/SDK/platform-tools`.
6. The Meta Quest Developer Hub's own `platform-tools`, under the local
   `Programs` directory.

The Headset section of the dialog shows which adb was found, its version, and its
source (`configured`, `path`, or `discovered`).

### Pointing theDAW at adb

When discovery misses adb, the Headset section shows an "adb was not found"
notice with a path field. Enter the full path to the adb executable (for example
`C:\...\platform-tools\adb.exe`) and click Save. theDAW runs `adb version`
against that path to confirm it is a working adb, then persists it to
`data/quest.json` so later sessions reuse it. A path that is not a file, or that
does not run as adb, is rejected with an error and not saved.

Installing Android platform-tools or the Meta Quest Developer Hub is the
alternative when no adb is present on the machine at all.

## Selecting the target device

Click Rescan in the dialog header to query adb for connected devices. Each device
is listed with its model, a `(Quest)` tag when it is recognized as a Meta
headset, and its serial number. A device that is not ready shows its adb state
(for example `unauthorized` or `offline`) in brackets.

Choose the headset from the Target device dropdown. The dialog preselects the
first ready Quest, falling back to the first listed device. When no device is
detected, connect the Quest over USB, confirm developer mode and the USB
debugging prompt, then Rescan.

## Choosing an APK

The APK file field holds the path to the .apk that will be installed. There are
three ways to fill it.

### Get Latest

The Get Latest button downloads the newest .apk release asset from the
`gantasmo/theDAW-XR` GitHub release into `data/quest`. The download is cached
server side by file size, so a repeated click reuses the file on disk instead of
pulling it again. On success the field is set to the downloaded path and the
release tag is shown. This is the standard way to deploy the current build
without a local copy.

### Choose APK

The Choose APK button opens the operating system's file picker, filtered to
.apk files, and sets the field to the selected path. This is for an APK that
already exists on the machine, such as a build produced elsewhere.

### Manual path

Typing or pasting a full path into the APK file field works directly. The last
APK used is remembered in `data/quest.json` and seeded into the field on the next
open.

## Launching after install

The Package name field is optional and is used only to start the app after the
install finishes. When it is filled and the "Launch on the headset after
installing" checkbox is on, theDAW runs the package's launcher activity so the
app opens on the headset without reaching for it in the Quest library. The
package name looks like `com.YourCompany.theDAWXR`. Leaving the field empty
installs the APK without launching it. The package name is remembered for the
next deploy.

## Running the deploy

Click Deploy once an adb is available and the APK field is set. The dialog
installs the APK onto the selected device, then launches the package if one was
given and the launch checkbox is on. A result log appears below the button
reporting whether the install succeeded, the raw adb output, and, when a package
was launched, whether the launch was confirmed. A failed install or an
unconfirmed launch is shown in the log so the cause can be read directly.
