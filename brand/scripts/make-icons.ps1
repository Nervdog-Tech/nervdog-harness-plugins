# Renders art/husky-W21-stripes.png as rounded squares (corner radius = edge / 4, same as the sidebar mark):
#   assets/mark.png                128 px, the plugin's mark
#   icons/png/<size>.png           ICO frames (git-ignored), packed by pack-ico.mjs into icons/nervdog-harness.ico
#   icons/icon.png                 1024 px, the desktop About panel icon (nervdog-harness desktop/brand-exe.mjs)
# Run from brand/: powershell -NoProfile -ExecutionPolicy Bypass -File scripts\make-icons.ps1; then node scripts/pack-ico.mjs
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'art\husky-W21-stripes.png'
$png = Join-Path $root 'icons\png'
New-Item -ItemType Directory -Force -Path $png | Out-Null

function Save-Rounded([System.Drawing.Image]$image, [int]$size, [string]$path) {
  $scaled = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($scaled)
  $g.InterpolationMode = 'HighQualityBicubic'; $g.PixelOffsetMode = 'HighQuality'; $g.CompositingQuality = 'HighQuality'
  $g.DrawImage($image, 0, 0, $size, $size)
  $g.Dispose()

  $out = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($out)
  $g.SmoothingMode = 'AntiAlias'; $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $r = [single]($size / 4); $d = 2 * $r; $s = [single]$size
  $path2 = New-Object System.Drawing.Drawing2D.GraphicsPath
  $path2.AddArc(0, 0, $d, $d, 180, 90)
  $path2.AddArc($s - $d, 0, $d, $d, 270, 90)
  $path2.AddArc($s - $d, $s - $d, $d, $d, 0, 90)
  $path2.AddArc(0, $s - $d, $d, $d, 90, 90)
  $path2.CloseFigure()
  $brush = New-Object System.Drawing.TextureBrush $scaled
  $g.FillPath($brush, $path2)
  $brush.Dispose(); $path2.Dispose(); $g.Dispose(); $scaled.Dispose()
  $out.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
}

$image = [System.Drawing.Image]::FromFile($source)
try {
  foreach ($size in 16, 20, 24, 32, 40, 48, 64, 96, 128, 256) { Save-Rounded $image $size (Join-Path $png "$size.png") }
  Save-Rounded $image 1024 (Join-Path $root 'icons\icon.png')
  Save-Rounded $image 128 (Join-Path $root 'assets\mark.png')
} finally { $image.Dispose() }
Write-Output "rendered $png, icon.png, assets\mark.png"
