# Bundled terminal font

`CascadiaMonoNF.woff2` is Microsoft's Cascadia Mono NF, shipped unmodified from
the [cascadia-code](https://github.com/microsoft/cascadia-code) release
`v2407.24`.

It is bundled rather than left to the host because Cascadia is not installed on
a stock Windows — it arrives with Windows Terminal or Visual Studio. Without it
the terminal fell back to Consolas, which has no glyphs in the Nerd Fonts
private-use ranges, and a starship or oh-my-posh prompt rendered as a row of
boxes.

Two variants exist and the distinction is easy to get backwards:

- **Mono** is the variant _without_ ligatures. That is what we want: ligatures
  break column alignment in `git log --graph`, `less`, and diff output.
- **NF** is Microsoft's own Nerd Fonts build, carrying the icon ranges.

The file is the variable font (weight axis 200–700), declared as such in
`src/index.css` so `fontWeight` settings use the axis instead of a synthesized
bold.

## Licence

SIL Open Font License 1.1, reproduced verbatim in `OFL.txt`. The OFL permits
bundling with and redistribution alongside software under any licence,
including this project's Apache-2.0. Two obligations follow:

- Ship `OFL.txt` and the copyright notice with the binary. The Tauri bundle
  includes this directory, and the setting that selects the font names the
  licence.
- Do not rename a modified copy to a Reserved Font Name. We ship the font
  unmodified, so this does not apply — but it does mean any future subsetting
  or patching has to be published under a different family name.

Regenerate with:

```powershell
# Download CascadiaCode-<version>.zip from the release page, then:
Expand-Archive CascadiaCode-<version>.zip -DestinationPath .
Copy-Item woff2/CascadiaMonoNF.woff2 src/assets/fonts/
Invoke-WebRequest https://raw.githubusercontent.com/microsoft/cascadia-code/v<version>/LICENSE -OutFile src/assets/fonts/OFL.txt
```
