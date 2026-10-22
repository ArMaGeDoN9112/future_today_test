param([Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$html = Get-Content (Join-Path $root 'catalogs/sources/okso-table.html') -Raw -Encoding utf8
$levels = @{ '03' = 'bachelor'; '04' = 'master'; '05' = 'specialist' }
$directions = @([regex]::Matches($html, '(?s)<tr>(.*?)</tr>') | ForEach-Object {
    $cells = @([regex]::Matches($_.Groups[1].Value, '(?s)<td[^>]*>(.*?)</td>') | ForEach-Object {
        [System.Net.WebUtility]::HtmlDecode(($_.Groups[1].Value -replace '<[^>]*>', '')).Trim()
    })
    if ($cells.Count -ge 2 -and $cells[0] -match '^\d\.(\d{2}\.(03|04|05)\.\d{2})$') {
        [pscustomobject][ordered]@{ id = "okso-$($cells[0])"; code = $Matches[1]; name = $cells[1]; level = $levels[$Matches[2]] }
    }
} | Sort-Object id)
$ids = [System.Collections.Generic.HashSet[string]]::new()
foreach ($entry in $directions) {
    if ([string]::IsNullOrWhiteSpace($entry.name) -or -not $ids.Add($entry.id)) { throw 'Пустое название или повтор ID.' }
}
foreach ($level in $levels.Values) {
    if (-not ($directions | Where-Object level -EQ $level)) { throw "Пустой уровень $level." }
}
$courses = @(foreach ($definition in @(
    @{ level = 'bachelor'; name = 'Бакалавриат'; last = 4 },
    @{ level = 'master'; name = 'Магистратура'; last = 2 },
    @{ level = 'specialist'; name = 'Специалитет'; last = 5 }
)) {
    foreach ($number in 1..$definition.last) {
        $last = $number -eq $definition.last
        [ordered]@{
            id = "$($definition.level)-$number$(if ($last) { 'plus' })"
            name = "$($definition.name) — $number курс$(if ($last) { " и выше ($number+)" })"
            level = $definition.level
            course = "$number$(if ($last) { '+' })"
        }
    }
})
$snapshot = [ordered]@{ version = $Version; 'study-directions' = $directions; 'study-courses' = $courses }
$json = ($snapshot | ConvertTo-Json -Depth 5).Replace("`r`n", "`n") + "`n"
$destination = Join-Path $root "catalogs/snapshots/$Version-study.json"
if (Test-Path -LiteralPath $destination) {
    if ([System.IO.File]::ReadAllText($destination) -cne $json) { throw 'Опубликованный снимок нельзя менять: задайте новую версию.' }
} else {
    [System.IO.File]::WriteAllText($destination, $json, [System.Text.UTF8Encoding]::new($false))
}
Write-Output "$Version study-directions=$($directions.Count)"
