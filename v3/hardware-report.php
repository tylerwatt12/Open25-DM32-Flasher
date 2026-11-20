<?php
// SPDX-License-Identifier: GPL-3.0-or-later
declare(strict_types=1);

header('Cache-Control: no-store');

if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    header('Allow: POST');
    http_response_code(405);
    exit;
}
if (($_SERVER['HTTP_ORIGIN'] ?? '') !== 'https://kd8zmm.com') {
    http_response_code(403);
    exit;
}
if (($_SERVER['CONTENT_TYPE'] ?? '') !== 'application/json') {
    http_response_code(415);
    exit;
}
$body = file_get_contents('php://input', false, null, 0, 4097);
if ($body === false || strlen($body) > 4096) {
    http_response_code(413);
    exit;
}

function report_keys(mixed $value, array $required, array $optional = []): bool
{
    return is_array($value) && !array_is_list($value) &&
        array_diff($required, array_keys($value)) === [] &&
        array_diff(array_keys($value), array_merge($required, $optional)) === [];
}

function report_text(mixed $value, int $maximum): bool
{
    return is_string($value) && strlen($value) >= 1 && strlen($value) <= $maximum &&
        preg_match('/[\x00-\x1f\x7f]/', $value) === 0;
}

function report_sha256(mixed $value): bool
{
    return is_string($value) && preg_match('/\A[0-9a-f]{64}\z/', $value) === 1;
}

function report_uuid(mixed $value): bool
{
    return is_string($value) &&
        preg_match('/\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\z/', $value) === 1;
}

function report_chip(mixed $value): bool
{
    return report_keys($value, ['jedec', 'size']) &&
        is_string($value['jedec']) &&
        preg_match('/\A(?!00|ff)[0-9a-f]{6}\z/', $value['jedec']) === 1 &&
        is_int($value['size']) && $value['size'] >= 4096 && $value['size'] <= 16777216 &&
        $value['size'] === 1 << hexdec(substr($value['jedec'], -2));
}

function report_hardware(mixed $value): bool
{
    return report_keys($value, ['program', 'data', 'bootPrefixSha256', 'qualified']) &&
        report_chip($value['program']) && report_chip($value['data']) &&
        report_sha256($value['bootPrefixSha256']) && is_bool($value['qualified']);
}

function report_codec(mixed $value): bool
{
    if (!report_keys($value, ['nativeMatch'], ['headerMarker', 'headerVersion', 'slotBlank', 'slotSha256',
            'nativeSignatures', 'candidateCodeSha256', 'candidateCodeBytes', 'matchedProfile', 'tableCandidates']) ||
        !in_array($value['nativeMatch'], ['not-searched', 'no-signature', 'code-mismatch', 'tables-mismatch', 'matched'], true)) return false;
    $header = ['headerMarker', 'headerVersion', 'slotBlank', 'slotSha256'];
    if (array_intersect($header, array_keys($value))) {
        if (array_diff($header, array_keys($value)) || !is_bool($value['slotBlank']) || !report_sha256($value['slotSha256'])) return false;
        if ($value['slotBlank'] && ($value['headerMarker'] !== 4294967295 || $value['headerVersion'] !== 4294967295)) return false;
    }
    foreach (['headerMarker' => 4294967295, 'headerVersion' => 4294967295,
              'nativeSignatures' => 4194304, 'tableCandidates' => 4194304,
              'matchedProfile' => 65535, 'candidateCodeBytes' => 98304] as $key => $maximum) {
        if (array_key_exists($key, $value) && (!is_int($value[$key]) || $value[$key] < 0 || $value[$key] > $maximum)) return false;
    }
    if (array_key_exists('candidateCodeSha256', $value) !== array_key_exists('candidateCodeBytes', $value)) return false;
    return !array_key_exists('candidateCodeSha256', $value) ||
        report_sha256($value['candidateCodeSha256']) && $value['candidateCodeBytes'] > 0;
}

function report_error(mixed $value): bool
{
    return report_keys($value, ['name', 'message'], ['code', 'codec']) &&
        report_text($value['name'], 80) && report_text($value['message'], 500) &&
        (!array_key_exists('code', $value) || is_string($value['code']) &&
         preg_match('/\A[a-z][a-z0-9_]{0,63}\z/', $value['code']) === 1) &&
        (!array_key_exists('codec', $value) || isset($value['code']) &&
         str_starts_with($value['code'], 'codec_') && report_codec($value['codec']));
}

function report_diagnostic(mixed $value): bool
{
    if (!report_keys($value, ['version', 'pageId', 'event', 'workflow'],
            ['operationId', 'phase', 'appVersion', 'firmware', 'hardware', 'readbackVerified', 'verificationSkipped', 'verificationMethod', 'sectorReadbackVerified', 'resetSent', 'restartError', 'error']) ||
        $value['version'] !== 2 || !report_uuid($value['pageId']) ||
        !in_array($value['event'], ['page_view', 'hardware', 'operation_started', 'operation_succeeded',
            'operation_failed', 'operation_cancelled', 'verification_skipped'], true) ||
        !in_array($value['workflow'], ['connect', 'package', 'backup', 'install', 'restore', 'first_install', 'update', 'revert', 'info'], true)) {
        return false;
    }
    if (array_key_exists('operationId', $value) && !report_uuid($value['operationId'])) return false;
    if (!in_array($value['event'], ['page_view', 'hardware'], true) && !isset($value['operationId'])) return false;
    if (array_key_exists('appVersion', $value) && !report_text($value['appVersion'], 80)) return false;
    if (array_key_exists('phase', $value) && !in_array($value['phase'],
            ['connect', 'identify', 'archive', 'backup', 'save', 'preflight', 'install', 'restore', 'verify', 'restart', 'complete', 'info', 'revert', 'codec',
             'serial-supported', 'serial-unavailable'], true)) return false;
    if (array_key_exists('hardware', $value) && !report_hardware($value['hardware'])) return false;
    if ($value['event'] === 'hardware' && !isset($value['hardware'])) return false;
    if (array_key_exists('firmware', $value)) {
        $firmware = $value['firmware'];
        if (!report_keys($firmware, ['target', 'release', 'sha256']) ||
            !report_text($firmware['target'], 80) || !report_text($firmware['release'], 120) ||
            !report_sha256($firmware['sha256'])) return false;
    }
    foreach (['readbackVerified', 'verificationSkipped', 'sectorReadbackVerified', 'resetSent'] as $key) {
        if (array_key_exists($key, $value) && !is_bool($value[$key])) return false;
    }
    if (($value['readbackVerified'] ?? false) && ($value['verificationSkipped'] ?? false)) return false;
    if (array_key_exists('verificationMethod', $value)) {
        $method = $value['verificationMethod'];
        if (!in_array($method, ['sector-crc32', 'sector-readback', 'full-byte-readback', 'skipped'], true) ||
            !in_array($value['workflow'], ['install', 'restore', 'first_install', 'update', 'revert'], true)) return false;
        if ($method === 'sector-crc32' &&
            (!in_array($value['workflow'], ['first_install', 'update', 'revert'], true) ||
             ($value['readbackVerified'] ?? null) !== false || ($value['verificationSkipped'] ?? null) !== false)) return false;
        if ($method === 'sector-readback' &&
            (!in_array($value['workflow'], ['first_install', 'update', 'restore'], true) ||
             ($value['readbackVerified'] ?? null) !== false || ($value['verificationSkipped'] ?? null) !== false ||
             !isset($value['sectorReadbackVerified']) ||
             $value['event'] === 'operation_succeeded' && $value['sectorReadbackVerified'] !== true)) return false;
        if ($method === 'full-byte-readback' &&
            (($value['readbackVerified'] ?? null) !== true || ($value['verificationSkipped'] ?? null) !== false)) return false;
        if ($method === 'skipped' &&
            (($value['readbackVerified'] ?? null) !== false || ($value['verificationSkipped'] ?? null) !== true)) return false;
    }
    if (array_key_exists('sectorReadbackVerified', $value) && ($value['verificationMethod'] ?? null) !== 'sector-readback') return false;
    if ($value['event'] === 'operation_succeeded' && in_array($value['workflow'], ['first_install', 'update', 'revert'], true) &&
        !in_array($value['verificationMethod'] ?? null, ['sector-crc32', 'sector-readback'], true)) return false;
    if ($value['event'] === 'operation_succeeded' && in_array($value['workflow'], ['install', 'restore'], true) &&
        ($value['verificationMethod'] ?? null) !== 'sector-readback' && (!isset($value['readbackVerified'], $value['verificationSkipped']) ||
         $value['readbackVerified'] === $value['verificationSkipped'])) return false;
    if ($value['event'] === 'verification_skipped' &&
        (!in_array($value['workflow'], ['install', 'restore'], true) ||
         ($value['readbackVerified'] ?? null) !== false || ($value['verificationSkipped'] ?? null) !== true)) return false;
    if (array_key_exists('error', $value) && !report_error($value['error'])) return false;
    if (array_key_exists('restartError', $value) &&
        (!report_error($value['restartError']) || ($value['resetSent'] ?? null) !== false ||
         !in_array($value['workflow'], ['install', 'restore', 'first_install', 'update', 'revert'], true))) return false;
    return $value['event'] !== 'operation_failed' || isset($value['error']);
}

function report_ip_in_range(string $ip, string $cidr): bool
{
    [$network, $bits] = explode('/', $cidr, 2);
    $packed = @inet_pton($ip);
    $prefix = inet_pton($network);
    if ($packed === false || $prefix === false || strlen($packed) !== strlen($prefix)) return false;
    $bytes = intdiv((int)$bits, 8);
    $remaining = (int)$bits % 8;
    return substr($packed, 0, $bytes) === substr($prefix, 0, $bytes) &&
        ($remaining === 0 || (ord($packed[$bytes]) & (255 << (8 - $remaining))) === ord($prefix[$bytes]));
}

function report_visitor_ip(): ?string
{
    $peer = $_SERVER['REMOTE_ADDR'] ?? '';
    if (!is_string($peer) || filter_var($peer, FILTER_VALIDATE_IP) === false) return null;
    // Pinned from https://www.cloudflare.com/ips-v4/ and /ips-v6/ on 2026-11-14.
    // Only Cloudflare transport peers may supply the real visitor header.
    $cloudflare = ['173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
        '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
        '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
        '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22', '2400:cb00::/32',
        '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
        '2a06:98c0::/29', '2c0f:f248::/32'];
    foreach ($cloudflare as $range) {
        if (!report_ip_in_range($peer, $range)) continue;
        $visitor = $_SERVER['HTTP_CF_CONNECTING_IP'] ?? '';
        return is_string($visitor) && filter_var($visitor, FILTER_VALIDATE_IP) !== false ? $visitor : $peer;
    }
    return $peer;
}

function report_append(string $path, array $data, int $maximum): bool
{
    // The root-owned parent directory cannot be replaced by the PHP worker.
    // Refuse links/non-regular files even if an administrator created one.
    if (is_link($path) || !is_file($path)) return false;
    $row = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE) . "\n";
    $log = @fopen($path, 'ab');
    if ($log === false) return false;
    $written = false;
    if (flock($log, LOCK_EX)) {
        $stat = fstat($log);
        if ($stat !== false && ($stat['mode'] & 0170000) === 0100000 &&
            $stat['size'] + strlen($row) <= $maximum) {
            $written = fwrite($log, $row) === strlen($row) && fflush($log);
        }
    }
    fclose($log);
    return $written;
}

$report = json_decode($body, true, 8);
if (report_hardware($report)) {
    // Compatibility for already-open pages using the old hardware-only payload.
    // The legacy file and its schema stay intact; all new pages send version 2.
    $written = report_append('/var/lib/open25-dm32/hardware-reports.jsonl',
        ['day' => gmdate('Y-m-d')] + $report, 4 * 1024 * 1024);
} elseif (report_diagnostic($report)) {
    $agent = $_SERVER['HTTP_USER_AGENT'] ?? '';
    $agent = is_string($agent) ? substr(preg_replace('/[\x00-\x1f\x7f]/', ' ', $agent), 0, 512) : '';
    $written = report_append('/var/lib/open25-dm32/diagnostics.jsonl',
        ['timestamp' => gmdate('Y-m-d\TH:i:s\Z'), 'ip' => report_visitor_ip(), 'userAgent' => $agent] + $report,
        16 * 1024 * 1024);
} else {
    http_response_code(400);
    exit;
}
http_response_code($written ? 204 : 503);
