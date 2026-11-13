# Small Plotter

A drawing app, color SVG converter, and public artwork gallery for an eight-marker pen plotter running RepRapFirmware / Duet Web Control.

The canvas supports freehand pencil strokes, straight lines, rectangles, ellipses, hatched fills, and a drag eraser with undo and redo. Import color SVGs with automatic marker matching, or turn a webcam selfie into adjustable squiggle art. Optional selfie background removal runs locally with the bundled TensorFlow.js model.

Built-in pictures are discovered from every unique `.gcode` basename in `assets/`. A matching `.png` or `.jpg` file is used as its card preview (`.jpeg` is also supported for existing assets); the app then generates the usual bed-sized, pen-controlled Duet job.

## Use

1. With Node.js installed, run `node server.mjs` (defaults to `http://127.0.0.1:8080`; override the bind address and port with `HOST` and `PORT`).
2. Open that address in a modern desktop browser.
3. Open **⚙️ Admin** and unlock it with the built-in UI password, `meowl`. Under **Duet connection**, enter the board address, for example `http://192.168.1.42` (a pasted `/rr_upload` suffix also works). The optional Duet password is separate from the admin UI password.
4. Set **Tool colors** to match the markers loaded in `T0`–`T7`, and set **Drawing area** and speeds for the machine. The initial drawing area is 118 × 118 mm.
5. Draw a picture, import a color SVG, take a selfie, or pick a premade picture.
6. Click **Draw it!** to upload `0:/gcodes/small-plotter.gcode`. It starts after upload when **Admin → Job → Start after upload** is enabled.

To download instead, open **⚙️ Admin → Job → Save .gcode** after preparing artwork. This saves the generated file, including marker tool changes, without contacting the board. **G-code** in the same section opens the job preview. Drawing, SVG conversion, previewing, and downloading work without a connected plotter.

There is no build step or package install. Public saved drawings and their print counts are stored in `.data/drawings.json`; `.data/` is intentionally ignored by Git. Each saved drawing is also copied to that browser's `localStorage`, so the artist retains a local copy if the public server is temporarily unavailable.

The **Pick a premade picture** view includes the public saved-drawings gallery, sortable by recency or popularity. Opening a saved drawing creates an editable working copy; the original remains unchanged, and saving the copy creates a new gallery entry with a visible “Remix of …” attribution. Popularity is the number of times an unchanged saved drawing has been sent to the plotter. Unlocking the admin panel can temporarily show per-drawing delete buttons or permanently delete the full gallery after confirmation.

## Generated G-code

Each stroke is sent as:

```gcode
G0 X… Y… F…
M280 P0 S115
G4 P25
G1 X… Y… F…
M280 P0 S95
G4 P25
```

Every job uses absolute positioning, lifts the pen and homes before drawing, then unmounts the pen with `T-1`, homes, and disables the motors:

```gcode
G90
M280 P0 S95
G4 P60
G28
...
T-1
G28
M84
```

The browser sends the job directly to the Duet over HTTP; the Node.js server serves the app and gallery API. `rr_upload` receives a raw POST body, not multipart form data. Uploads include a CRC32, wait for the firmware's upload-status response, and verify the saved byte count with `rr_fileinfo` before `M32` is sent when responses are readable. The app attempts to delete the previous `small-plotter.gcode` before each upload so an equally-sized old file does not satisfy verification; deletion failures are logged. The app warms the Duet HTTP connection with `GET rr_upload` before each upload to avoid stale keep-alive resets seen in Firefox (`rr_connect` is used only when a password is entered). Upload POSTs use one controlled recovery attempt with the same filename and CRC; the start command is never retried because doing so could restart a running plot.

For full upload confirmation, serve this page over HTTP and allow its origin in RepRapFirmware with `M586`. If cross-origin responses cannot be read, including typical `file://` use, the app falls back to opaque requests. In that mode it serializes the upload-status and file-info requests and waits before starting, but cannot confirm upload success or the saved byte count. Use Duet Web Control to monitor or stop the running job.

The admin-locked log panel records request IDs, browser information, transport mode, timings, upload byte counts and CRC, verification results, retries, and the exact point at which `M32` is dispatched. Passwords and G-code query contents are redacted.

Before running a new plot, make sure the plotted area, pen settings, homing configuration, and feed rates are safe for the specific machine.

## Color markers and SVG import

The plotter uses eight marker tools, `T0` through `T7`. Choose **Import a color SVG** on the home screen, or **Import SVG** above the drawing canvas. Open the **⚙️ admin panel**, unlock it, and use **Tool colors** to set the eight swatches to match the markers physically loaded in those tools. The palette is remembered in this browser.

SVG source colors are matched to the closest configured marker using OKLab color distance. The canvas previews those matched colors, and the color assignment chips show which tool each source color uses. Changing a swatch updates the preview and generated G-code. Clicking a `T` button selects the marker for new drawing strokes, fills, and selfies.

The importer supports paths (including curves and separate subpaths), rectangles, circles, ellipses, lines, polylines and polygons, group transforms, inherited styles, and CSS solid colors. Artwork fits within the square canvas with its aspect ratio preserved. Solid fills become diagonal hatch lines, including holes defined by fill rules; stroked outlines become pen paths. Stroke widths are represented by the physical marker width. Generated jobs group paths by their matched marker to minimize tool swaps. Markers run in the order they first appear in the drawing, with path order preserved within each marker group. This can change layering at overlaps, where marker strokes can blend on paper. White is matched like any other source color; remove white background shapes if they should remain blank paper.

Convert text and symbols to paths before importing. Gradients, patterns, embedded images, clipping, masks, filters, dashed strokes and arrow markers are rejected with an explanatory message. Imports are limited to 2 MB, 500 generated strokes and 50,000 sampled points. Scripts and event handlers are stripped, and SVG processing is isolated from the app with external resources blocked.

Jobs lift the pen, wait for queued moves with `M400`, select the required marker using `T0`–`T7`, then lift the pen again before traveling to the next path. All paths assigned to the same marker share one tool selection, even when their source SVG colors differ. Each used marker is selected once per job. Grouping happens when G-code is generated for preview, download or upload; it does not reorder the editable canvas strokes or undo history. The final machine commands are exactly `T-1`, `G28`, and `M84`; the previous servo park commands are no longer emitted. Pen-servo commands still lift and lower the pen during drawing; the Duet must have the corresponding tools and tool-change macros configured. Monochrome drawings without stored color use `T0` and end with the same unmount/home/motors-off sequence. Colors survive gallery saves, remixes, undo and erasing.

Run the algorithm checks with `node --test tests/color.test.cjs` and the isolated gallery API test with `node --test tests/server.test.mjs`. Open `tests/browser.html` through the local server to run browser checks for conversion, color persistence, previews and generated tool changes. These checks do not contact the plotter.
