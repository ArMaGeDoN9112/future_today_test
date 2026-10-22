param([Parameter(Mandatory)][ValidatePattern('^\d{4}-\d{2}-\d{2}$')][string]$Version)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$source = Join-Path $root 'catalogs/sources'
$cities = @(Import-Csv (Join-Path $source 'towns.csv') -Encoding utf8 | ForEach-Object {
    [pscustomobject][ordered]@{ id = $_.fias_id; name = $_.city; region = $_.region_name }
} | Sort-Object id)
$raw = Get-Content (Join-Path $source 'universities.json') -Raw -Encoding utf8 | ConvertFrom-Json
$excluded = Get-Content (Join-Path $source 'university-exclusions.json') -Raw -Encoding utf8 | ConvertFrom-Json -AsHashtable
$universities = @($raw.results.bindings | Where-Object {
    $_.name.value -notmatch 'колледж|техникум|факультет' -and -not $excluded.ContainsKey(($_.item.value -split '/')[-1])
} | ForEach-Object {
    [pscustomobject][ordered]@{ id = ($_.item.value -replace '^http://www.wikidata.org/entity/', ''); name = $_.name.value }
} | Sort-Object id)
foreach ($entries in @($cities, $universities)) {
    if (-not $entries.Count) { throw 'Пустой справочник.' }
    $ids = [System.Collections.Generic.HashSet[string]]::new()
    foreach ($entry in $entries) {
        if ([string]::IsNullOrWhiteSpace($entry.id) -or [string]::IsNullOrWhiteSpace($entry.name) -or -not $ids.Add($entry.id)) {
            throw 'Отсутствующий ID/название или повтор ID.'
        }
    }
}
if ($cities | Where-Object { -not $_.region -or $_.id -notmatch '^[0-9a-f-]{36}$' }) { throw 'Некорректный город.' }
if ($universities | Where-Object { $_.id -notmatch '^Q[1-9][0-9]*$' }) { throw 'Некорректный QID.' }
$snapshot = [ordered]@{ version = $Version; cities = $cities; universities = $universities }
$json = ($snapshot | ConvertTo-Json -Depth 5).Replace("`r`n", "`n") + "`n"
$destination = Join-Path $root "catalogs/snapshots/$Version.json"
if (Test-Path -LiteralPath $destination) {
    if ([System.IO.File]::ReadAllText($destination) -cne $json) { throw 'Опубликованный снимок нельзя менять: задайте новую версию.' }
} else {
    New-Item -ItemType Directory -Force (Split-Path $destination -Parent) | Out-Null
    [System.IO.File]::WriteAllText($destination, $json, [System.Text.UTF8Encoding]::new($false))
}
Write-Output "$Version cities=$($cities.Count) universities=$($universities.Count)"
