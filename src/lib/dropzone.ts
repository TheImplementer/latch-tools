// -----------------------------------------------------------------------
// Drop-zone wiring, shared by every tool that takes a file.
//
// Three controllers had grown identical copies of this — redact.ts, and both
// PDF controllers. It looks like boilerplate but it isn't: each handler here is
// load-bearing, and a copy that quietly drops one degrades in a way nobody
// notices until someone reports that the tool "doesn't work" on their machine.
//
//   - preventDefault on dragover is what makes the element a drop target at
//     all. Without it the browser navigates away to the dropped file.
//   - dragleave AND dragend both have to restore the label, or a drag that ends
//     outside the window leaves the zone stuck in its "drop it" state.
//   - stopPropagation on the browse button stops the dropzone's own click
//     handler firing after it and opening the picker a second time.
//   - Enter and Space are what make a div with role="button" actually operable
//     from the keyboard, which is a requirement, not a nicety.
//   - Clearing fileInput.value after every change is what lets someone pick the
//     same file again after a reset. Without it the second pick is silent.
// -----------------------------------------------------------------------

export interface DropzoneOptions {
  /** The [data-el="dropzone"] element. */
  dropzone: HTMLElement;
  fileInput: HTMLInputElement;
  /** The visible "Browse" button inside the drop zone. */
  browseBtn: HTMLElement;
  /** The line of text that changes while a drag is over the zone. */
  dzTitle: HTMLElement;
  /** Label at rest, restored whenever a drag ends. */
  idleLabel: string;
  /** Label shown while a drag is over the zone. */
  dropLabel: string;
  /**
   * Fired when a *fresh* selection begins — a drop, or any of this drop zone's
   * own controls opening the picker. Deliberately NOT fired by openPicker(),
   * so a caller's own control can mean something different.
   *
   * This exists because a change event can't say which control opened the
   * picker: /redact-image/ uses it to tell "replace the batch" from "add more
   * to it".
   */
  onFreshSelection?(): void;
  /** Receives whatever the user chose, by any route. Never called with none. */
  onFiles(files: File[]): void;
}

export interface DropzoneHandle {
  /** Open the picker from a caller-owned control, without onFreshSelection. */
  openPicker(): void;
}

export function createDropzone(opts: DropzoneOptions): DropzoneHandle {
  const { dropzone, fileInput, browseBtn, dzTitle } = opts;

  const idle = () => {
    dropzone.classList.remove("is-drag");
    dzTitle.textContent = opts.idleLabel;
  };

  const freshPick = () => {
    opts.onFreshSelection?.();
    fileInput.click();
  };

  dropzone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropzone.classList.add("is-drag");
    dzTitle.textContent = opts.dropLabel;
  });
  for (const ev of ["dragleave", "dragend"]) {
    dropzone.addEventListener(ev, idle);
  }

  dropzone.addEventListener("drop", (e) => {
    e.preventDefault();
    idle();
    opts.onFreshSelection?.();
    const files = Array.from((e as DragEvent).dataTransfer?.files ?? []);
    if (files.length) opts.onFiles(files);
  });

  dropzone.addEventListener("click", freshPick);
  dropzone.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" || ke.key === " ") {
      e.preventDefault();
      freshPick();
    }
  });
  browseBtn.addEventListener("click", (e) => {
    // Otherwise the dropzone's own click handler runs next and reopens it.
    e.stopPropagation();
    freshPick();
  });

  fileInput.addEventListener("change", () => {
    const files = Array.from(fileInput.files ?? []);
    if (files.length) opts.onFiles(files);
    // So the same file can be chosen again after a reset.
    fileInput.value = "";
  });

  return {
    openPicker: () => fileInput.click(),
  };
}
