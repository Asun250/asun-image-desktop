# Historical feature notes

These notes preserve the desktop development record. Installation-specific evidence, logs, screenshots and private saved projects are not distributed. Older model limits and verification counts may describe earlier builds; use the repository README and current source for setup and current behavior. Relative feature-report paths refer to files in the repository root.

# Asun IMG 1.6.7

A local desktop-browser image editor for Windows. Double-click the **Asun IMG** desktop shortcut to open it. Imported PNG, JPEG and WebP source files retain their original bytes and dimensions. Separate generated thumbnails make previews lightweight; they do not replace those sources.

## Image generation

The bottom composer has an **Image model** dropdown and **Generate** button. It uses the same connected model choices as Character / item sheet, including GPT Image 2.5 Sunburst and Flare when the configured API account has access. Choose a model and enter a prompt to create a new image, or describe edits to the current canvas. Instructions and linked photos on visible numbered areas also work without a global prompt. Ordinary image generation does not inherit sheet layout or white-background rules.

Generation sends a snapshot of the visible composition, separate annotation guides, applicable original reference photos, photo notes and exact area-mask guides to OpenAI. Shared groups retain their separate selected shapes. Guides tell the model where to edit; they do not guarantee pixel-identical preservation. The service accepts up to 16 input images total (including guides and masks), with a combined 64 MB limit. It rejects incomplete requests before submitting them.

After the short upload, generation continues in the background queue. Workflow tabs show **Queued**, **Generating**, **Ready**, or an error. Use **New tab** to keep creating, or click another tab to resume its latest edits. Each tab retains its images, references, areas, prompt, model/quality, undo/redo, view rotation, and independent main/sketch drafts. Generating again from a tab that already has a job creates another tab for the new submission. **Open workflow** in the queue returns to the live draft if it is still open; a closed workflow reopens its submitted setup. See `WORKFLOW_TABS.txt` for local recovery and closing behavior.

Completed jobs stay in their tabs and queue without replacing the active canvas or opening a result over other work. **View result** offers **Edit output image**, **Redo with all references**, **Save image**, **Add as new layer**, and **Add to references**. Edit output image opens the generated pixels in a new editable tab. Redo opens the native setup captured for that generation in another tab: original images, selected areas, references and their annotations, instructions, model and quality. Neither starts another generation. These actions are also available for sheet results and in Generation history. Older results without a saved source setup explain why Redo is unavailable; their output can still be edited. See `RESULT_EDITING.txt` for details.

Click a completed preview or **Enlarge / inspect** to examine the full-resolution output in a large viewer before saving. **Fit**, **100%**, zoom controls, scroll-to-zoom and drag-to-pan make details easy to inspect. Save directly from the viewer, or use **Back to result** / Esc to return without changing the editor. Sheet results and history use the same viewer.

Adding a layer is undoable; the original canvas is never replaced automatically. **View result** reopens the selected workflow's latest result. An interrupted browser connection can retrieve the same request with **Check submission**, without starting another paid generation. Use **Check connection** to refresh model access. Each new explicit Generate action uses the connected OpenAI API account and incurs API charges. No automatic paid retries are made.

The **Quality** dropdown keeps **high** as its default. Sunburst and Flare offer auto, low, medium, high, xhigh and max; earlier models offer up to high. The selected value is sent unchanged. Unsupported values show an error instead of being downgraded. Model and quality choices remain separate for main-page images and sheets.

**Generation history** opens its own page while keeping the editor available. Browse images and character / item sheets, download results, and inspect the exact recorded prompt, requested model/quality/size, actual output dimensions and input photos/guides. Request details are saved before the API call and belong to that result, even after the editor controls change. Older jobs without saved request details show **Not recorded**. Each local image/sheet history keeps up to 2 GiB and 2,048 requests; reaching a limit stops new generation with an explicit error instead of deleting old results. Save an editable `.asun` project to retain added result layers and references. See `GENERATION_SETTINGS.txt` for request details and `CHARACTER_ITEM_SHEETS.txt` for the seven-angle sheet workflow.

The sheet creator accepts multiple **subject photos** in step 1 and multiple **detail references** in step 3. Both sections support file selection, drag and drop, pasted images and a Google Images search shortcut. Web-image drops import the chosen public image through a bounded local service; sites that reject imports can still use copied image bytes or a saved photo. Click a photo to open the large editor with Pencil, Highlight, Text, zoom/pan, undo/redo and photo-specific instructions. Save and back keeps the editable marks; Cancel discards the draft. Originals and existing canvas/reference annotations remain separate. Generation and request-pack export include the selected clean originals, annotation-guide images and a precise photo-to-instruction mapping. A circled or named building can therefore be requested as the sole sheet subject, excluding the surrounding scene.

## Asun IMG name and icon

Windows taskbar, Alt+Tab and title-bar icons now use the supplied husky too. The launcher runs a hidden window-branding helper that assigns the stable **Asun.IMG** identity, husky icon and Asun relaunch command to this editor's Edge/Chrome app windows. It also updates older open Asun editor windows without reloading their projects. Regular browser windows and other apps are excluded. Matching desktop/taskbar shortcuts use the same identity. The helper keeps native icon handles alive, restores them if the browser replaces them, and stops after all Asun windows close. The current `icon.ico` and `favicon.ico` compatibility files contain the husky as well.

The app is named **Asun IMG** in the browser/window title, project-title suffix, startup status, accessibility labels, footer and user messages. The desktop shortcut is **Asun IMG**, with your supplied pixel husky as its icon. The browser uses the same husky through a fresh favicon filename so it can load without the old icon cache.

The supplied PNG is preserved byte-for-byte as **branding/husky-source.png**. The icon contains 16, 24, 32, 48, 64, 128 and 256px sizes; separate 192 and 512px PNGs are also included. All use the original artwork and mint background, with nearest-pixel scaling and matching padding to retain the full proportions. No artwork was repainted or removed.

Use **Launch Asun IMG.ps1** or the renamed desktop shortcut. The older **Launch Asun image.ps1** filename remains a compatibility alias. Internal project identifiers, **.asun** files, preference keys and local service identity remain unchanged, so existing projects and workflows still work. Names and text written by you inside a project are preserved.

## Startup animation

Each fresh app window or reload first shows your supplied **starup.gif**. Its full 1280 × 720 artwork fits the window without cropping, with the matching mint background filling other aspect ratios. It plays one native 6.4-second sequence, then reveals the editor as soon as initialization is complete. Click **Skip** or press **Esc** to continue sooner. The editor stays hidden and cannot accept edits, dropped files or paste commands during the introduction.

The installed **public/startup.gif** is byte-for-byte identical to the supplied file; its 80 frames, 80ms frame timing and original loop metadata are untouched. The screen ends after one cycle while the header logo continues its existing infinite loop. Missing or failed startup images fall back immediately; an image that never finishes loading falls back after eight seconds, with editor readiness still required. Startup does not change projects, source images, references, exports or the saved theme.

## Reference Studio

The photo window is now simply **References**, with the selected area shown beside its title. **Find a reference** appears first: search the web, copy an image in your browser, then paste it here. Folder import, Paste photo and the existing-project-photo selector share one aligned row.

Your photos appear in a separate scrolling collection with clear photo indices, filenames, a selected state and individual top-right **×** removal buttons. Select a photo to annotate it in the larger workspace. Move, Text / number, Pencil and Highlight use the same colorful illustrated icons as the main tool rail; the color wheel and editing actions follow the same style. **Photo notes** stay with a photo, and **Area comment** stays with its number. Comments still work without photos. **Save changes** and Cancel remain visible while the window scrolls. Removing or editing photos stays staged until Save; Cancel discards the whole draft.

Light and dark modes both use warm, coordinated panels, readable controls and consistent spacing. The bottom References strip has aligned thumbnails, number badges, remove buttons and an illustrated Add photos control. The paginated board chooser follows the same design. Exported numbered boards now use warm rounded cards, coral label tags, aligned full-frame photos and clear note/instruction panels. The board image stays the same in either app theme.

Original image bytes, file formats, dimensions, annotations, links, notes and project storage are preserved. Clean originals in **Complete reference pack** remain separate from generated board previews; all original photos keep their number mappings. Existing projects open without migration.

## Animated header logo

The top-left branding displays the husky and **Asun IMG** on a transparent background in both themes. The separately generated `public/main-logo-transparent.gif` clears the turquoise matte and green shadow from every coalesced frame while retaining all native foreground pixels. Original pixel dimensions, 60 frames, 80ms timing and infinite looping are preserved. The untouched supplied GIF remains at `public/main-logo.gif` and at its original path. The 4.8-second animation repeats continuously while the app is visible. Header display keeps the original proportions, scaled to 56px high on wide windows and 50px on smaller/shorter windows. The GIF is app branding, separate from image projects and exports.

## Appearance

The editor now follows the approved **Pearl Light** layout, with rounded panels, cool neutral canvas surroundings and blue primary actions. The top-right **sun/moon button** switches to **Graphite Dark** and back. Your preference is remembered on this computer for subsequent launches; light is the default. It is an app preference, separate from saved image projects. Changing themes never recolors image pixels, numbers, pencil strokes or original files.

The left tool rail uses nine original, warm, flat illustrated SVG tiles: Move, Mask, Restore, Crop, Text, Pencil, Highlight, Objects and Hand. Labels, keyboard shortcuts and mouse-wheel switching stay available.

Use **Layers / Properties** tabs in the right inspector to switch between the layer list and the selected layer's X/Y/W/H, opacity and image adjustments. Properties becomes available when a layer is selected. Collapse History or the live numbered Edit summary when you want more space. The bottom reference and prompt composer spans the workspace. The existing scene/reference copy action is now labeled **Copy board** in the header; the full-resolution **Complete reference pack** ZIP remains available beside Import and Paste.

Reference sheets, comments, notes, annotation controls, color wheels, export dialogs and context menus follow the selected theme. On shorter screens, choosing a reference annotation tool brings its working area above the sticky Save footer. Theme and panel changes are independent of undo history and exported images. Image generation displays its connection status in the composer. Local SAM 2 remains unchanged.

## Centered Auto detect

**Auto detect** sits at the horizontal center of the top toolbar, with 26px text, a 184 × 68px light blue button, and a soft light that travels around its rounded border every seven seconds. The animation repeats while the button is available, pauses during detection, and becomes static when the operating system requests reduced motion. Text, brush and zoom controls remain separate. Selecting an editable pencil/highlight mark shows **Detect marked area** in the same centered slot; its confirmation and manual fallback are unchanged.

## Use it

1. Import, drag in or paste PNG, JPEG or WebP images. The first image in an empty document sets its size. Further images become layers.
2. Select a layer on the canvas or in Layers. Drag to move it, drag its lower-right handle to resize, or open Properties and use the X/Y/W/H fields. Lock ratio preserves proportions.
3. Mask hides pixels; Restore brings masked pixels back. Brush size is in document pixels. Original file bytes remain embedded and unchanged.
4. Use layer visibility, ordering arrows or drag-to-reorder, duplication, opacity and image adjustments. Double-click a layer name to rename it.
5. Before / after shows the first imported original on the left and current edit on the right. Move the split slider. Turn comparison off to edit.
6. Variants stores named snapshots of your own edits. References and prompts are saved with the project. To generate an image, select an available Image model and choose Generate; review the returned image before adding it to your project.
7. Save project downloads an editable `.asun` file containing original images, layers, masks, detected object selections, text and drawing annotations, references, prompt and variants. Open project restores it. Browser downloads normally go to Downloads unless browser settings choose another destination. Saving also confirms any text currently being entered on the canvas.
8. Export downloads a flattened PNG or JPEG. PNG preserves transparent pixels; JPEG uses white behind them. Save a project separately to retain layers.

Crop changes the canvas bounds. Canvas size adds or removes transparent canvas without generating content.

Scroll the mouse wheel over the main canvas to switch through the tools on the left rail. Wheel up chooses the previous tool; wheel down chooses the next. The order is Move, Mask, Restore, Crop, Text, Pencil, Highlight, Objects and Hand, then it wraps. Small trackpad motions accumulate before switching. A tool change confirms valid pending canvas text; an invalid draft stays available for correction. Wheel switching pauses during an active pointer gesture or pending crop. Scrolling over text fields, panels, menus and dialogs retains their normal behavior.

Hold **Ctrl** while scrolling over the main canvas to zoom at the pointer. The Fit, 100% and +/− buttons remain available, and Space+drag pans the view.

## Start a fresh project

Click **DELETE ALL** at the left of the action row under **Layers** to reset the current project to an empty **Untitled, 1600 × 1000** canvas. It clears all layers, annotations, masks, numbered regions, linked photos, original images embedded in the current project, comments, photo notes, the scene prompt and variants. The edit summary, navigator and reference gallery update immediately. The next imported, dropped or pasted photo becomes the new clean MAIN and sets the canvas to its native dimensions.

One **Undo / Ctrl+Z** restores the complete previous project, including its original file bytes, editable annotations, references, notes and variants. Redo returns to the fresh project. This action does not modify saved project files, uploaded source files or previous releases on disk. Save the project separately when you want a durable copy of the current work; an empty reset project can also be saved and reopened.

Valid pending canvas text and prompt edits are retained in the undo state; invalid text must be corrected first. A pending crop is cancelled. Reset is unavailable while an operation, image copy, pointer gesture or dialog is active, and while the project is already at its untouched empty defaults. Native Enter and Space activate the focused button. Brush/color preferences remain available for the next project.

## Fit photos without extra canvas

Importing, dropping or pasting a main photo into an empty layer stack automatically sets the canvas to that photo's full native width and height and places it at 0,0. This also works after deleting all previous layers, even though earlier original files remain saved in the project. Portrait, landscape, square and extreme-aspect images retain their proportions; the canvas no longer inherits transparent side margins from the previous image. Existing image size and file limits still apply. Additional scene layers fit within the current composition, and reference photos retain their separate gallery behavior.

For a photo already placed on a larger or cropped canvas, click **Fit canvas to photo** beside **Canvas size** (**Fit photo** in compact windows). Select the photo first when the scene contains several image layers. A sole photo is also available while a text or drawing layer is selected. The action appears when a valid full-photo fit would change the scene. It restores that photo's native dimensions and aspect, and maps all current layer positions and sizes with the photo so text, drawings, masks and chosen regions stay aligned. Reference photo notes and annotations remain separate and unchanged. Undo restores the prior canvas and layer transforms in one fit step.

Fitting uses the selected photo's full rectangular frame. Other layer content outside that frame is clipped by the canvas while its editable layers remain saved. Source transparency or borders already present in the uploaded image remain original pixels. All original file bytes and metadata, reference links, comments and saved variant snapshots are retained. The clean MAIN/before-after baseline remains the first preserved main image, following the existing project/export rule; retained replacement image originals remain available alongside it.

Saved custom canvas sizes and intentional crops reopen as saved. Use the fit action to repair an existing padded project; new empty-scene imports fit automatically. The normal viewport **Fit** command and Ctrl+wheel zoom continue to control how the canvas appears on screen. The full-photo fit control works immediately after completing a crop and remains accessible beside text and detection controls at compact and wide sizes.

## Review your edit summary

The **Edit summary** panel beside the canvas lists the current numbered areas in number order, including manually placed numbers and automatically or manually selected object regions. Each entry shows the number, a generated detail preview for a selected region, its full area comment, linked reference photo thumbnails and filenames, full photo notes, and reference annotation counts. **Scene prompt** shows your overall instructions. Previews are generated separately from the preserved original files.

Click an entry, or focus it and press Enter, to open its existing references/comment editor. **Save changes** updates the summary; Cancel keeps the previously saved instructions. The panel also updates after numbering, editing labels, changing links, undo/redo, restoring a variant and reopening an editable project. Typing the overall prompt updates its summary immediately; its existing project-save behavior is unchanged. All text remains selectable and supports normal Ctrl+C copying, including while the canvas retains keyboard focus.

Numbers without instructions remain visible so you can finish them. Hidden, transparent or off-canvas labels show why they are excluded from the board. Conflicting duplicate labels show the same conflict that the board exporter checks. A hidden region source is warned about separately: a visible number's comment and references still follow the existing board rules. Unlinked photos are counted but do not acquire invented numbers.

Scroll inside the summary to review long comments and larger collections. Its arrow collapses or reopens it; the canvas refits to the available space. Canvas tool-wheel switching and Ctrl+wheel zoom remain available over the canvas. The summary is a view of the existing project data, with no new storage format. It does not become part of scene PNGs, numbered boards or clean originals, and does not change their export layouts or mappings.

## Find and number objects locally

Import a main image, click **Auto detect**, or choose **Objects** (A). Asun runs Meta SAM 2.1 on this computer to find selectable regions. Wait for the region count, then move the pointer over the image: a light highlight previews the region under it. Click to add the next unused positive number and open that object's reference-photo gallery. Only objects you click receive numbers. Manual number labels are included when choosing the next number.

New object numbers default to **180 px**, five times the previous 36 px base, and **red (#ff0000)**. Unnumbered hover outlines, guided selection previews and newly saved object outlines also default to red. Auto detect, Detect marked area and Use marked area use the same new-number style, independent of the ordinary Text tool's last size or color. The current number remains editable with the normal size and color controls; its chosen outline follows its stored number color. Subsequent newly numbered objects start at 180 px red. Reopening older projects retains their saved sizes, colors and outlines. Manual text and reference-photo annotations retain their existing defaults.

Numbers are placed inside the canvas when their measured text box fits, including multi-digit labels at image edges. The 180 px setting is a fixed document size; on a canvas smaller than the label, normal canvas clipping still applies. Use the existing size control to adjust a particular label when needed. Zoom changes the on-screen scale without changing its native export size.

In Objects mode, click a visible number glyph or its selected object to reopen its references. Transparent text padding and erased glyphs allow nearby objects underneath to be selected. Moved and resized visible numbers keep priority over the object beneath them. Mask/Restore applies to number glyph clicks. Move retains its normal whole-layer selection behavior.

Add photos from a folder, drag photos into the gallery, search on the web or paste a copied image. Add editable marks and notes to each reference photo, then click **Save changes**. Click that numbered object again with Objects, or click its number with Move, to reopen the same gallery. Cancel discards unsaved reference changes while retaining the newly created number. The number remains an editable text layer: change its words, size, color or position using the existing text controls. Its selected region and linked photos remain saved with it. Undo/redo applies to object numbering and saved reference changes.

If regions overlap, hold **Alt** and scroll over the object to preview another candidate, then click it. Plain scrolling still changes tools; Ctrl+scroll still zooms. Hover highlights are temporary and excluded from copied images and exported boards. Chosen object outlines and number labels are included in scene exports and reference boards. Their masks follow the source layer when it moves or resizes, and the canvas crop clips them. Clean original MAIN and reference files in a Complete reference pack retain their uploaded bytes, including any marks already present in those uploaded files.

Detection uses a separate working copy at most 1,600 pixels per side. It does not alter the original image. Results are cached for the current source, so pointer movement reuses masks rather than running inference again. **Detect again** explicitly reruns detection. Saved projects retain chosen masks, numbers and reference links; unchosen candidates are a session cache and can be detected again after reopening.

SAM finds regions rather than guaranteeing a complete semantic object inventory. It may select an object part, overlap several objects or miss an object. Alt+scroll can choose an alternative candidate where one exists. Text, Pencil and Highlight remain available for manual markings. If the local model is missing or detection fails, Asun reports an error and keeps the editable scene intact; use the manual tools or try Auto detect again.

The unchanged detection engine was tested in 1.4.0: the supplied 575 × 819 scene produced 75 regions on the installed RTX 3090. Independent browser validation measured about 3.2 seconds of model inference and 7.5 seconds from the first click, including cold startup. Masks covered inspected points on the car, monitor, woman, bronze bull and desk; a whole-desk candidate was also present. These measurements apply to that image and machine; they are not an instant-response or universal object-accuracy guarantee. The supplied image already contains circles and numbers; those remain original pixels rather than editable annotations or recognized existing labels.

## Detect a missed object from your mark

Draw one Pencil circle around the object, or paint across it with Highlight. The completed stroke stays selected. Click **Detect marked area** in the toolbar (**Detect mark** in compact windows). To use an earlier mark, select its drawing layer first. This replaces the Auto detect button while a supported visible mark is selected; selecting the image layer or using Objects returns to the whole-image automatic workflow.

Asun crops a clean working copy from the original image beneath the mark, with surrounding context, and gives that box to the installed local SAM 2 model. App-added colors, text, circles, filters and masks are not painted into the detection image. Marks already baked into an uploaded source remain part of that source. The original uploaded bytes and dimensions stay unchanged; no new model download or service is involved.

Review the proposed selection. If several candidates are available, use **Proposed selection** to compare them. Click **Number this area** to add the next unused number and open its normal reference/comment dialog. You can add photos, a comment, or both. A preview creates no label until confirmed; **Cancel**, X or Esc discards it. Your original drawing remains a separate editable layer, so you can revise or hide it yourself.

If the model misses the object, includes unwanted surroundings, is unavailable, or returns no useful mask, click **Use marked area** and check the manual preview. Then use **Number this area**. Highlight uses the painted stroke; an approximately closed Pencil loop includes its interior. An open Pencil line uses the stroke itself. This gives missed items the same numbering, references and area comments without requiring successful AI detection.

Guidance helps the detector focus on small details; transparent lenses and thin frames can still be ambiguous. This feature uses one selected mark at a time. Cropped analysis and saved full-image selection grids are bounded to 1,600 pixels per side. The preview displays the exact canonical mask that is saved, including any small detail expansion at that grid resolution. Saved masks follow their source image layer through move/resize and are clipped by the canvas, like automatic selections. Projects retain editable masks and drawings independently of clean originals.

## Annotate and copy

Choose **Text** (T), click anywhere on the image, and type your label. Press **Enter** to confirm both the text and its position. Text remains selected as the tool, so click another location to add another label. Shift+Enter adds a new line; Esc cancels the pending label. Set the text size and color in the toolbar. Double-click text on the canvas, or select its layer and use the **T** edit button in Layers, to revise its words. Text annotations remain separate editable layers in the saved project.

To recolor text or a number label, use the Text tool or select an existing text/number layer with Move. Click **Color wheel** in the toolbar, choose a color with the hue/saturation wheel, brightness slider, preset swatches or six-digit HEX field, then click **Apply color**. The color updates the selected text and becomes the default for future labels in the current session, even after selecting a different label. While entering text, the wheel previews the new color; **Cancel** restores the previous draft color. Saved `.asun` projects retain each label's color.

Choose **Pencil** (P) and drag to draw freehand, circle an area or paint a mark. Choose **Highlight** (L) to draw translucent highlights over image details. Set the annotation color and brush size before drawing. Each stroke becomes its own layer, so you can move, resize, hide, reorder or remove it, and undo/redo annotation changes. Original image pixels remain preserved in the project.

Right-click the image and choose **Copy image with annotations** to copy the full edited canvas, including all visible text, pencil strokes and highlights, as a PNG. Ctrl+C also copies the image while the canvas is focused; when typing in a field it retains normal text copying. This copies the document at its actual pixel dimensions; zoom, selection handles and other editor controls are excluded. Any pending text is confirmed before copying. Then paste into the ChatGPT message composer with Ctrl+V or its Paste command. Copying uses the local system clipboard and sends no image to a remote service.

Keep the app focused while copying. Edge/Chrome may require local clipboard permission; if copying is blocked, allow clipboard access for the local app or choose **Download annotated PNG** from the right-click menu and attach that file. A copied PNG is flattened; save an `.asun` project separately to retain editable annotations.

## Comments for numbered areas

Select an automatically detected object or a manual text/number label and open **References / comment**. Enter instructions in **Comment for this area**, such as “Remove the black bar and preserve the whole scene.” No photo is required. A comment belongs to that number, separately from **Notes for this photo**. Add photos as well when useful. **Save changes** commits the comment and photos together; Cancel, X or Esc discards pending changes. Enter creates a new line in the comment field; it does not submit the dialog.

Comments support up to 2,000 characters and remain editable through undo/redo, duplicate, saved variants and `.asun` save/reopen. Click a commented number with Move to reopen it, or select its layer and use **View comment**. Removing linked photos keeps the area comment; clearing the comment keeps photo links.

**Copy board** and board downloads work with comments alone. Each comment appears as a numbered Instruction card, separate from photo tiles and photo notes. All instruction lines are retained, continuing across pages when necessary. **Complete reference pack** also works without reference photos when an original MAIN image and a visible commented label exist. Its mapping records each number’s comment and linked photo filenames; comment-only numbers have an empty reference list. Original image bytes are preserved. Area comments require Asun 1.4.1 or later.

## Link numbered labels to reference photos

Select a text or number label with Move, then use **References / comment**. Selecting an available reference adds it to the gallery, or use **Add photos from folder…** to select several files. A label can have multiple reference photos. Click a linked label in Move, or use **View references**, to open its photo gallery inside Asun. Drag still moves the label; double-click or use the Layers text-edit button to revise its words. Choose a gallery photo to view or annotate it. Click the **×** at the top-right of any thumbnail to remove that exact photo from this number's draft references, including duplicates with identical names. **Remove selected photo** remains available as well. Removing an inactive photo keeps the current photo and its annotation editor selected; removing the current photo selects its neighbor. Removing the last photo leaves the area comment available. Removing a photo from the project's References section clears its links in the current scene and saved variants.

Thumbnail removal is staged: **Save changes** commits it with the other dialog edits, **Cancel** or the dialog's close button discards it, and one Undo restores a saved removal. A saved reference's original bytes stay in the project library and it remains linked to any other numbers using it. To remove a photo globally, use the project's References section. The × buttons are always visible, work with mouse or keyboard, and pause while photos load. Valid pending annotations are retained before removal; an invalid annotation remains available for correction.

You can also drag several PNG, JPEG or WebP photos from File Explorer into the reference dialog. Files are added to the gallery, so another drop adds photos instead of replacing the previous selection. Click **Save changes** to save all draft links, newly added photos and reference annotations together. **Cancel** or Esc discards unsaved changes and preserves the existing links and annotations. Original filenames and source bytes remain embedded in the editable `.asun` project. Unsupported files are rejected; copied links are not fetched, and dropping a URL does not navigate away from the app. The folder chooser remains available.

To find a reference online, enter search words in the reference dialog and click **Search on web**, or press Enter in the search field. This opens Google Images after your search action and sends your query text to Google. It does not upload your scene or reference photos. In the browser, right-click the photo itself and choose **Copy image**, then return to the linked-reference dialog and press **Ctrl+V** to add it to that label's gallery. Copying an image URL or ordinary text does not fetch an image. Pasting words in the search field or reference text editor keeps normal text behavior; pasting actual image data adds a gallery photo and keeps pending reference annotation words on the original photo.

The dialog's **Paste photo** button also adds image data from the clipboard after your explicit click. It may require browser clipboard-read permission. If access is blocked, return to the dialog and press Ctrl+V, or save the browser image and use the folder chooser. Clipboard reads happen only after a paste action; search and paste do not run in the background. Pasted photos remain drafts until **Save changes**; **Cancel** discards them with the other unsaved reference edits.

With a gallery photo selected, use the reference editor's **Text**, **Pencil** or **Highlight** tools to add labels, circle details or mark areas on that photo. Text confirms with Enter; its color wheel, size and normal edit controls remain available. Reference annotations stay separate editable layers over the original photo, with their own undo/redo controls. Switching gallery photos retains the pending annotations in the dialog draft. **Save changes** commits them with the label's links; **Cancel** discards them. Edits to a reference photo appear for every label that uses that same embedded photo.

Use **Notes for this photo** beneath the reference editor to describe the selected photo in up to 2,000 characters. Notes belong to that embedded photo and stay with it when you switch gallery photos. **Save changes** saves the notes together with links and annotations; **Cancel** or Esc discards the dialog's unsaved changes. Saved `.asun` projects retain the editable notes. Notes are ordinary text, so text selection, typing and pasting words keep their normal behavior.

Use **Copy board** to copy a PNG board containing the annotated **MAIN** scene and its linked reference photos, including reference annotations and each photo's notes beneath it. Visible labels with linked photos or area comments are included, and labels sharing a photo share one reference tile. A label's multiple photos carry that same label. Area comments have their own numbered Instruction cards. Use distinct label numbers to make the mapping clear. Boards contain at most 12 reference or instruction entries per page; notes and comments can cause earlier page breaks, and exceptionally long notes continue with the photo on further pages so every line is included. For multiple pages, the export dialog lets you choose a page to copy or download all pages in one ZIP containing separately named PNGs. Extract and attach every page in ChatGPT to include all linked photos and notes, or copy each page in turn. Each page repeats MAIN and identifies its page number. A board with one page downloads directly as a PNG. The boards scale images to fit; the editable project retains their original sources. If clipboard access is blocked, use the download action. Normal **Copy image with annotations** still copies only the scene.

A flattened PNG cannot retain clickable links or give ChatGPT access to a local folder path. Browser file import provides the selected filename, not a reliable full local folder path. Asun stores the photo itself, so a saved project does not depend on the original file staying in its folder. Asun opens older projects and migrates single-photo links. Save multiple-photo links and editable reference annotations in the new project format and reopen them in Asun 1.2.0 or later.

Copying a scene or reference board writes only to the local clipboard. Image generation uses the separate Generate action and the connected API account.

Choose **Complete reference pack** above the canvas, from the right-click menu or from the reference-page export window to download a ZIP containing annotated reference board pages, the clean original MAIN image, every main image and reference photo retained in the project, `mapping.json` and `README.txt`. The original photo files retain their uploaded bytes and dimensions. The clean MAIN is the first imported image as originally supplied; the boards show your current composition, crop and annotations. Each number's folder contains its linked photos, including shared photos under each applicable number. Unassigned photos remain in their own folder. Mapping records retain original filenames, dimensions, photo notes, area comments, labels and file checksums. Cropping, resizing and annotating changes the editable scene while preserving these originals. Save an `.asun` project separately to retain editable layers, links and annotations. The pack becomes available when the project has an imported MAIN image and a visible label with a reference photo or area comment.

## Paste an image from ChatGPT

In ChatGPT, use the generated image's **Copy image** action or right-click the image and choose **Copy image**. Then click the Asun canvas and press **Ctrl+V**. Copy the image itself; a copied link or text does not import an image. The first paste into an empty document sets the canvas to the image's pixel dimensions. Later pastes add image layers and retain existing originals and annotations. Undo/redo works for pasted layers, and Save project embeds their source images in the editable `.asun` file.

You can also click **Paste image** above the canvas or right-click the canvas and choose **Paste image**. These buttons use the browser's clipboard-read API and may require permission for the local app. If permission is blocked, click the canvas and use Ctrl+V, or download the image from ChatGPT and import the file. Ctrl+V uses the normal paste event and avoids asking for clipboard-read permission.

If the Text tool is active and you paste an image while entering an annotation, Asun confirms your pending words and imports the image as a new layer. Pasting ordinary text into that annotation still works normally. Other text fields, including the prompt, retain ordinary text behavior. When the linked-reference dialog is open, pasted image data adds a draft reference photo rather than a scene layer; other dialogs do not import pasted images. Clipboard reads happen only after your paste action; the app does not read the clipboard in the background or fetch remote URLs copied as text.

## Shortcuts

V move, B mask, E restore, T text, P pencil, L highlight, C crop, A objects, H hand. Wheel over the main canvas switches tools; Ctrl+wheel zooms; Alt+wheel in Objects changes overlapping regions. Space + drag pans; 0 fits; 1 sets 100%. Ctrl+V pastes an image on the canvas. Ctrl+O imports; Ctrl+Shift+O opens a project; Ctrl+S saves; Ctrl+E exports. Ctrl+Z undoes; Ctrl+Shift+Z or Ctrl+Y redoes. Arrow keys move selected layers by one pixel; Shift moves ten. Delete removes a layer. Esc cancels a gesture, pending text or dialog. [ and ] resize the brush.

## Local operation

The Node server binds only to 127.0.0.1. Local detection uses same-origin status and image-analysis endpoints protected by a per-server token; the resized working image stays on this computer and goes to the app-owned SAM process. Detection starts after choosing Auto detect or Objects. The installed model runs offline; search opens Google Images only after the separate Search on web action and sends the query text.

Image and sheet generation use the existing `OPENAI_API_KEY` environment setting (process, or Windows User setting). The key stays on the local server, outside the browser and project files. Model access is checked on connection; images are uploaded only when Generate is explicitly pressed. Same-origin request tokens, bounded payload validation and persistent request IDs protect the generation routes. The service makes one provider submission per request ID, records results locally and does not retry paid requests automatically. This desktop version and its launcher are separate from the web/phone app.

The app-owned SAM runtime is in `<repository>/local-ai/sam2`, separate from system Python installations. It uses Python 3.12.14, PyTorch 2.7.1 with CUDA 12.6 and Meta SAM 2.1 Base Plus. The installed runtime occupies about 5.71 GB, including the 324 MB checkpoint. No optional custom CUDA extension is installed. Its worker starts when needed and exits after three minutes idle or when the app server closes. See that folder's `README.txt` and `runtime.json` for model provenance and the exact installation record.

Editing happens in browser memory. Save a project before closing; the app warns about unsaved changes. The app does not promise recovery after a browser crash.

The desktop shortcut calls this version's launcher directly. Future updates must update both the desktop shortcut and the root launcher. The launcher uses the existing Node.js and Edge/Chrome installations, keeps its server window hidden and reuses a healthy app server. It checks build 1.6.7 so it cannot reuse a different app build. This version prefers local port 48010 and tries ports through 48019 if needed. Logs are inside this version's logs folder. The Node server needs no npm dependencies; SAM uses its separate installed Python runtime. Previous app checkpoints remain in the versions folder.

## Validation

Build 1.6.6 passed 23 focused checks: seven app-branding/assets/project-export cases, eleven animated-header/layout cases and five existing project-reset compatibility cases. All 25 production JavaScript syntax checks passed. Source PNG and both GIF hashes remain unchanged. Every ICO entry validates with native source colors; small Windows icon sizes load through the native icon reader and the 256px PNG is decoded separately. Both theme layouts were visually inspected.

Legacy edited projects open, save and reopen without losing user-authored wording. Real annotated PNG export and Complete reference pack preserve original bytes and stable number mappings. Production logic is unchanged: files with renamed strings match 1.6.5 after only the visible-name substitution, and all other public modules/assets plus the local detection bridge hash-match 1.6.5. The SAM worker differs only in its user-facing error name. Previous releases and saved user projects remain intact. See RELEASE.json, VERIFICATION.txt and qa/app-brand.

## Draw / sketch reference

The desktop navigation and Create menu include a separate Draw / sketch reference workspace. Editable pencil scenes on white can be automatically detected or manually highlighted, numbered, and connected to the existing full References editor. Each workflow tab retains its main and sketch projects with separate Undo histories; local tab recovery also saves these drafts. Save each `.asun` project for a portable backup. Generation receives the drawn scene as its composition, with selection marks as separate guidance. See `DRAW_SKETCH.txt` for the workflow and local-detector limitations.

Main-page web image search is available on the empty canvas and from Search images above the canvas. Choose a result to import its original as a normal editable photo; Auto detect, highlights and References work as with local uploads. See MAIN_IMAGE_SEARCH.txt for search, paste, drag-and-drop and direct-link options.

## Edit image

Choose **Edit image** to paint/refine an object selection or use Auto detect. **Erase selected** makes an immediate reversible transparent cutout; **Remove & fill** explicitly uses the chosen image model and quality to rebuild the background. The complete source setup stays available through Undo and generation Redo. Generated outputs open in this workspace when you choose **Edit output image**. Back returns to the ordinary editor with the same native project. See `EDIT_IMAGE.txt` for controls, references, and verification.

## Rotate the view or an image layer

Use **Rotate view**, beside Fit, to turn the workspace for comfortable painting or masking. It has a slider, an exact angle field, left/right 90-degree buttons and Reset. On narrower windows the button shows a rotation icon and the current angle. This temporary view angle does not change the saved image, exported composition or generation inputs. Fit and zoom work with the rotated view; rulers resume when the view returns to 0 degrees.

To change an image's actual angle, select its layer and open **Properties → Rotate image layer**. The same angle controls rotate the raster around its center. Masks, detected areas and their bound number labels follow the image; source photo bytes remain intact. The angle is saved in `.asun` projects and variants and appears in exported images and generation inputs. A slider adjustment is one Undo step. Independent pencil/text layers remain in document coordinates, and the sketch's white paper stays fixed.

The canvas keeps its current size, so corners outside it are clipped. Use **Fit photo** when you want the canvas to include the full rotated photo. Restoring a nonuniformly stretched, rotated photo to native proportions can require shearing other layers; that case reports a clear limitation instead of distorting them. See `ROTATION.txt` for usage and verification evidence.

## Background generation and Job queue

**Generate** now saves a separate job, including the current composition, original photos, references, selected areas, annotations, prompt, model and quality. After the short preparation/upload step, you can keep editing or choose **Create** to start another project. Images, Remove & fill requests and character/item sheets share one queue and run in the order accepted, one provider request at a time. Changing the next project's settings does not change submitted jobs.

Open **Job queue** in the header to see generating, queued, ready, failed and canceled jobs. The badge counts active jobs. You can cancel a queued job before it starts, reopen its saved setup, or open a finished result to inspect, download, edit or redo it. The queue includes a **New project** button. Finished jobs do not open a dialog or replace your current canvas automatically. The sheet page also has a Job queue button; full generation history keeps older records.

Jobs and their source setups are stored locally before submission. They survive a browser refresh; keep this PC and the local Asun service running for processing. On a service restart, queued jobs resume, while a request already marked as submitted is never automatically sent again if its outcome is uncertain. Errors and unsupported provider settings are reported with that job. Existing storage limits still apply. See `JOB_QUEUE.txt` for details and verification.
