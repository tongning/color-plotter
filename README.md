# Small Plotter

A drawing and public artwork gallery for a pen plotter running RepRapFirmware / Duet Web Control.

The canvas supports freehand pencil strokes, straight lines, rectangles, ellipses, and a drag eraser with one-step undo for each erase gesture.

Built-in pictures are discovered from every unique `.gcode` basename in `assets/`. A matching `.png` or `.jpg` file is used as its card preview (`.jpeg` is also supported for existing assets); the app then generates the usual bed-sized, pen-controlled Duet job.

## Use

1. Run `node server.mjs` (defaults to `http://127.0.0.1:8080`).
2. Open that address in a modern desktop browser.
3. Enter the board endpoint, for example `http://192.168.1.42/rr_upload`.
4. Set the physical drawing area to a safe rectangle within the machine's X/Y travel.
5. Draw with the pencil, line, rectangle, or ellipse tool, then click **Draw it!**. The job is uploaded as `0:/gcodes/small-plotter.gcode` and starts immediately when **Start after upload** is enabled.

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

Every job begins with the requested pen-up sequence and ends with the requested park/home/disable sequence:

```gcode
M280 P0 S95
G4 P60
...
M280 P0 S50
G4 P40
G28
M84
```

`rr_upload` receives a raw POST body, not multipart form data. Uploads include a CRC32, wait for the firmware's upload-status response, and verify the saved byte count with `rr_fileinfo` before `M32` is sent. The previous `small-plotter.gcode` is removed before each upload, so the stable filename does not accumulate jobs or allow an equally-sized old file to satisfy verification. The app warms the Duet HTTP connection with `GET rr_upload` before each upload to avoid stale keep-alive resets seen in Firefox (`rr_connect` is used only when a password is entered). Upload POSTs use one controlled recovery attempt with the same filename and CRC; the start command is never retried because doing so could restart a running plot.

For full upload confirmation, serve this page over HTTP and allow its origin in RepRapFirmware with `M586`. When opened directly as a `file://` page without CORS permission, browser security makes Duet responses opaque. In that mode the app serializes the upload-status and file-info requests and waits for an SD-card completion barrier before starting, but it cannot display the returned JSON. Use Duet Web Control to monitor or stop the running job.

The admin-locked log panel records request IDs, browser information, transport mode, timings, upload byte counts and CRC, verification results, retries, and the exact point at which `M32` is dispatched. Passwords and G-code query contents are redacted.

Before running a new plot, make sure the plotted area, pen settings, homing configuration, and feed rates are safe for the specific machine.

## Color markers and SVG import

The plotter uses eight marker tools, `T0` through `T7`. Choose **Import a color SVG** on the home screen, or **Import SVG** above the drawing canvas. Open the **⚙️ admin panel**, unlock it, and use **Tool colors** to set the eight swatches to match the markers physically loaded in those tools. The palette is remembered in this browser.

SVG source colors are matched to the closest configured marker using OKLab color distance. The canvas previews those matched colors, and the color assignment chips show which tool each source color uses. Changing a swatch updates the preview and generated G-code. Clicking a `T` button selects the marker for new drawing strokes, fills, and selfies.

The importer supports paths (including curves and separate subpaths), rectangles, circles, ellipses, lines, polylines and polygons, group transforms, inherited styles, and CSS solid colors. Artwork fits within the square canvas with its aspect ratio preserved. Solid fills become diagonal hatch lines, including holes defined by fill rules; stroked outlines become pen paths. Stroke widths are represented by the physical marker width. Layer order is retained, so overlapping marker strokes can blend on paper. White is matched like any other source color; remove white background shapes if they should remain blank paper.

Convert text and symbols to paths before importing. Gradients, patterns, embedded images, clipping, masks, filters, dashed strokes and arrow markers are rejected with an explanatory message. Imports are limited to 2 MB, 500 generated strokes and 50,000 sampled points. Scripts and event handlers are stripped, and SVG processing is isolated from the app with external resources blocked.

Jobs lift the pen, wait for queued moves with `M400`, select the required marker using `T0`–`T7`, then lift the pen again before traveling to the next path. Adjacent paths using the same marker share one tool selection. The existing pen-servo and homing commands still apply; the Duet must have the corresponding tools and tool-change macros configured. Monochrome drawings without stored color use `T0`. Colors survive gallery saves, remixes, undo and erasing.

Run the algorithm checks with `node --test tests/color.test.cjs` and the isolated gallery API test with `node --test tests/server.test.mjs`. Open `tests/browser.html` through the local server to run browser checks for conversion, color persistence, previews and generated tool changes. These checks do not contact the plotter.
