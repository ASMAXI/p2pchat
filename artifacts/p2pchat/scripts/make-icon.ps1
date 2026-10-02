Add-Type -AssemblyName System.Drawing
$src = "C:\Users\Max\.cursor\projects\c-Users-Max-IdeaProjects-p2pchat\assets\drift-app-icon.jpg"
$out = Join-Path $PSScriptRoot "..\src-tauri\icons"
New-Item -ItemType Directory -Force -Path $out | Out-Null
$img = [System.Drawing.Image]::FromFile($src)
$bmp = New-Object System.Drawing.Bitmap 1024, 1024
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.Clear([System.Drawing.Color]::FromArgb(255, 26, 31, 46))
$path = New-Object System.Drawing.Drawing2D.GraphicsPath
$path.AddEllipse(0, 0, 1023, 1023)
$g.SetClip($path)
$g.DrawImage($img, 0, 0, 1024, 1024)
$g.ResetClip()
$g.Dispose()
$pngPath = Join-Path $out "icon.png"
$bmp.Save($pngPath, [System.Drawing.Imaging.ImageFormat]::Png)
$public = Join-Path $PSScriptRoot "..\public\favicon.png"
$small = New-Object System.Drawing.Bitmap $bmp, 180, 180
$small.Save($public, [System.Drawing.Imaging.ImageFormat]::Png)
$small.Dispose()
# Build multi-resolution ICO manually (PNG-compressed ICO)
function Save-Ico($bitmap, $path) {
  $ms = New-Object System.IO.MemoryStream
  $sizes = @(16, 32, 48, 64, 128, 256)
  $images = @()
  foreach ($s in $sizes) {
    $resized = New-Object System.Drawing.Bitmap $bitmap, $s, $s
    $pngMs = New-Object System.IO.MemoryStream
    $resized.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $images += , @{ Size = $s; Bytes = $pngMs.ToArray() }
    $resized.Dispose()
    $pngMs.Dispose()
  }
  $bw = New-Object System.IO.BinaryWriter $ms
  $bw.Write([UInt16]0) # reserved
  $bw.Write([UInt16]1) # type icon
  $bw.Write([UInt16]$images.Count)
  $offset = 6 + (16 * $images.Count)
  foreach ($entry in $images) {
    $s = $entry.Size
    $bw.Write([Byte](if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([Byte](if ($s -ge 256) { 0 } else { $s }))
    $bw.Write([Byte]0) # colors
    $bw.Write([Byte]0) # reserved
    $bw.Write([UInt16]1) # planes
    $bw.Write([UInt16]32) # bit count
    $bw.Write([UInt32]$entry.Bytes.Length)
    $bw.Write([UInt32]$offset)
    $offset += $entry.Bytes.Length
  }
  foreach ($entry in $images) { $bw.Write($entry.Bytes) }
  $bw.Flush()
  [System.IO.File]::WriteAllBytes($path, $ms.ToArray())
  $bw.Dispose(); $ms.Dispose()
}
Save-Ico $bmp (Join-Path $out "icon.ico")
$bmp.Dispose()
$img.Dispose()
Write-Host "Icons written to $out"
Get-ChildItem $out | Format-Table Name, Length
