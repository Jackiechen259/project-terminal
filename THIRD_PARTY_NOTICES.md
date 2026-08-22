# Third-party notices

Project Terminal remains licensed under the Apache License 2.0. The terminal
engine migration adds the following direct Rust dependencies from the pinned
WezTerm repository revision:

| Package | License | Source revision |
| --- | --- | --- |
| `wezterm-term` | MIT | [`770d8e1a7519a9a698090cd7d717d0c64aa0a755`](https://github.com/wezterm/wezterm/tree/770d8e1a7519a9a698090cd7d717d0c64aa0a755) |
| `wezterm-cell` | MIT | same pinned revision |
| `wezterm-surface` | MIT | same pinned revision |

The dependency is pinned in `src-tauri/Cargo.toml` and resolved in
`src-tauri/Cargo.lock`; no floating branch is used. WezTerm's MIT notice is
reproduced below in the form required for redistribution:

```text
MIT License

Copyright (c) 2018-Present Wez Furlong

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The complete transitive Rust dependency set remains the authoritative set in
`Cargo.lock`. Release packaging should regenerate the project's normal license
report from that lockfile before shipping a binary.
