@echo off
REM Use this to build the Rust backend on this machine.
REM Reason: git-bash's /usr/bin/link.exe shadows MSVC's link.exe in PATH,
REM breaking the default MSVC toolchain build. We build against the GNU
REM toolchain instead (mingw-w64 gcc), which sidesteps that entirely.
set PATH=C:\Users\lucas\.cargo\bin;C:\Users\lucas\AppData\Local\Microsoft\WinGet\Packages\BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\mingw64\bin;%PATH%
set RUSTUP_TOOLCHAIN=stable-x86_64-pc-windows-gnu
cd /d %~dp0backend
cargo build --target x86_64-pc-windows-gnu %*
