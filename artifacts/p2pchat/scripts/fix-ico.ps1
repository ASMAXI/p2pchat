Add-Type -AssemblyName System.Drawing
$png = "c:\Users\Max\IdeaProjects\p2pchat\artifacts\p2pchat\src-tauri\icons\icon.png"
$ico = "c:\Users\Max\IdeaProjects\p2pchat\artifacts\p2pchat\src-tauri\icons\icon.ico"
$bmp = [System.Drawing.Bitmap]::FromFile($png)
$resized = New-Object System.Drawing.Bitmap $bmp, 256, 256
$hIcon = $resized.GetHicon()
$icon = [System.Drawing.Icon]::FromHandle($hIcon)
$fs = [System.IO.File]::Create($ico)
$icon.Save($fs)
$fs.Close()
$icon.Dispose()
$resized.Dispose()
$bmp.Dispose()
Write-Host "ico bytes=$((Get-Item $ico).Length)"
