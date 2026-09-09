# Hatch icon

`hatch-icon.png` is the 1024 x 1024 RGBA source for the approved Hatch mark.
The mark retains the warm ivory tile, sage hatch lid, and terracotta opening.
Transparent padding is part of the source; do not bake a checkerboard into it.

The concept was generated with the built-in image generation tool, then locally
masked to remove its mistakenly rendered checkerboard background. Interior
artwork was preserved. The frontend uses a 256 x 256 derivative at
`apps/hatch/src/assets/hatch-icon.png`.

Generate native assets from the repository root:

```sh
pnpm --filter hatch tauri icon ../../docs/brand/hatch-icon.png --output src-tauri/icons
```

The generated ICNS, ICO and PNG files are committed so native builds do not need
an image generation service. The icon command also refreshes the existing mobile
asset variants; this does not add mobile platform support.

Final image-generation brief: Extract the approved Hatch icon only. Preserve its
ivory rounded-square tile, green raised lid, terracotta rim, paper texture,
proportions, and upper-left lighting. Remove board labels, other concepts, and the
background. Deliver one centered square icon with transparent padding.
