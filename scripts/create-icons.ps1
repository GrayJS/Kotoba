$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$taskRoot = Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Force -Path (Join-Path $taskRoot 'assets'),(Join-Path $taskRoot 'src\public') | Out-Null
$taskImages = [System.Collections.Generic.List[byte[]]]::new()
$taskSizes = @(16,32,48,64,128,256)
foreach ($taskSize in $taskSizes) {
  $taskBitmap = [System.Drawing.Bitmap]::new($taskSize,$taskSize)
  $taskGraphics = [System.Drawing.Graphics]::FromImage($taskBitmap)
  $taskGraphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $taskGraphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $taskGraphics.Clear([System.Drawing.Color]::Transparent)
  $taskShape = [System.Drawing.Drawing2D.GraphicsPath]::new()
  $taskInset = [float]($taskSize * .04)
  $taskEdge = [float]($taskSize * .92)
  $taskRadius = [float]($taskSize * .38)
  $taskShape.AddArc($taskInset,$taskInset,$taskRadius,$taskRadius,180,90)
  $taskShape.AddArc(($taskInset+$taskEdge-$taskRadius),$taskInset,$taskRadius,$taskRadius,270,90)
  $taskShape.AddArc(($taskInset+$taskEdge-$taskRadius),($taskInset+$taskEdge-$taskRadius),$taskRadius,$taskRadius,0,90)
  $taskShape.AddArc($taskInset,($taskInset+$taskEdge-$taskRadius),$taskRadius,$taskRadius,90,90)
  $taskShape.CloseFigure()
  $taskGreen = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#c9ef93'))
  $taskInk = [System.Drawing.SolidBrush]::new([System.Drawing.ColorTranslator]::FromHtml('#213019'))
  $taskGraphics.FillPath($taskGreen,$taskShape)
  $taskFont = [System.Drawing.Font]::new('Microsoft YaHei UI',[float]($taskSize*.64),[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
  $taskFormat = [System.Drawing.StringFormat]::new()
  $taskFormat.Alignment = [System.Drawing.StringAlignment]::Center
  $taskFormat.LineAlignment = [System.Drawing.StringAlignment]::Center
  $taskRectangle = [System.Drawing.RectangleF]::new(0,[float](-$taskSize*.015),$taskSize,$taskSize)
  $taskGraphics.DrawString([string][char]0x8A00,$taskFont,$taskInk,$taskRectangle,$taskFormat)
  $taskStream = [System.IO.MemoryStream]::new()
  $taskBitmap.Save($taskStream,[System.Drawing.Imaging.ImageFormat]::Png)
  $taskImages.Add($taskStream.ToArray())
  if ($taskSize -eq 32) { [System.IO.File]::WriteAllBytes((Join-Path $taskRoot 'src\public\tray.png'),$taskStream.ToArray()) }
  $taskStream.Dispose(); $taskFormat.Dispose(); $taskFont.Dispose(); $taskGraphics.Dispose(); $taskBitmap.Dispose(); $taskShape.Dispose(); $taskGreen.Dispose(); $taskInk.Dispose()
}
$taskIconFile = [System.IO.File]::Create((Join-Path $taskRoot 'assets\icon.ico'))
$taskWriter = [System.IO.BinaryWriter]::new($taskIconFile)
$taskWriter.Write([uint16]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]$taskSizes.Count)
$taskOffset = 6 + 16 * $taskSizes.Count
for ($taskIndex=0; $taskIndex -lt $taskSizes.Count; $taskIndex++) {
  $taskDimension = if ($taskSizes[$taskIndex] -eq 256) { 0 } else { $taskSizes[$taskIndex] }
  $taskWriter.Write([byte]$taskDimension); $taskWriter.Write([byte]$taskDimension)
  $taskWriter.Write([byte]0); $taskWriter.Write([byte]0); $taskWriter.Write([uint16]1); $taskWriter.Write([uint16]32)
  $taskWriter.Write([uint32]$taskImages[$taskIndex].Length); $taskWriter.Write([uint32]$taskOffset)
  $taskOffset += $taskImages[$taskIndex].Length
}
foreach ($taskBytes in $taskImages) { $taskWriter.Write($taskBytes) }
$taskWriter.Dispose()
