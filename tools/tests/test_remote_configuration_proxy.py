"""远程配置代理每次联网，失败不得返回上次成功的状态地址。"""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('remote_configuration_proxy', ROOT / 'serve_local.py')
PROXY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PROXY)


def response(value):
    return io.BytesIO(json.dumps(value).encode('utf-8'))


class RemoteConfigurationProxyTests(unittest.TestCase):
    def test_each_request_reads_current_remote_response(self):
        with patch.object(PROXY, 'urlopen', side_effect=[
            response({'oltitle': 'https://first.example.com'}),
            response({'oltitle': 'https://next.example.com'}),
        ]) as request:
            first = PROXY.online_remote_configuration()
            second = PROXY.online_remote_configuration()
        self.assertEqual(request.call_count, 2)
        self.assertEqual(first['config']['oltitle'], 'https://first.example.com')
        self.assertEqual(second['config']['oltitle'], 'https://next.example.com')
        request.assert_called_with('https://oss.2t.hk/gtav/', timeout=4)

    def test_failed_request_clears_previous_content_and_sanitizes_error(self):
        with patch.object(PROXY, 'urlopen', side_effect=[
            response({'oltitle': 'https://first.example.com'}),
            OSError('https://user:secret@example.com private-error'),
        ]):
            self.assertEqual(PROXY.online_remote_configuration()['source'], 'remote')
            failed = PROXY.online_remote_configuration()
        self.assertEqual(failed, {
            'config': {'oltitle': ''}, 'source': 'unavailable', 'stale': True,
            'error': '远程配置暂时无法读取',
        })
        self.assertNotIn('secret', json.dumps(failed))

    def test_invalid_configuration_never_uses_previous_content(self):
        for value in [[], None, {'oltitle': 'http://example.com'},
                      {'oltitle': 'https://user:password@example.com'},
                      {'oltitle': '<img src=x>'}, {'oltitle': 'https://example.com\n'}]:
            with self.subTest(value=value), patch.object(PROXY, 'urlopen', return_value=response(value)):
                failed = PROXY.online_remote_configuration()
            self.assertEqual(failed['config'], {'oltitle': ''})
            self.assertEqual(failed['source'], 'unavailable')

    def test_malformed_or_oversized_response_is_unavailable(self):
        for payload in [b'{invalid}', b'x' * (256 * 1024 + 1)]:
            with self.subTest(size=len(payload)), patch.object(PROXY, 'urlopen', return_value=io.BytesIO(payload)):
                failed = PROXY.online_remote_configuration()
            self.assertEqual(failed['source'], 'unavailable')
            self.assertTrue(failed['stale'])

    def test_remote_server_routes_preserve_tls_and_proxy_paths(self):
        servers = [
            {'id': 'main', 'name': '公共战局', 'role': '主线路',
             'address': 'gtaserver.2t.hk:47485',
             'health_url': 'https://gtaserver.2t.hk:47485/47485/health'},
            {'id': 'experimental', 'name': '实验战局', 'role': '实验线路',
             'address': 'gtaserver.2t.hk:47486',
             'health_url': 'https://gtaserver.2t.hk:47486/47486/health',
             'websocket_url': 'wss://gtaserver.2t.hk:47486/47486/ws',
             'ws_url': 'wss://gtaserver.2t.hk:47486/47486/ws'},
        ]
        with patch.object(PROXY, 'urlopen', return_value=response({
            'oltitle': 'https://gtav.2t.hk', 'server': servers,
        })) as request:
            result = PROXY.online_remote_configuration()
        self.assertEqual(result['source'], 'remote')
        self.assertEqual(result['config']['servers'], servers)
        self.assertEqual(result['config']['server'], servers)
        self.assertEqual(request.call_count, 1)
        request.assert_called_once_with('https://oss.2t.hk/gtav/', timeout=4)

    def test_unsafe_server_fields_reject_entire_current_response(self):
        for field, value in [
            ('address', 'javascript://bad.example'),
            ('address', 'user:secret@example.com:47485'),
            ('address', 'example.com:70000'),
            ('health_url', 'http://example.com/health'),
            ('health_url', 'https://user:secret@example.com/health'),
            ('websocket_url', 'https://example.com/ws'),
            ('ws_url', 'wss://example.com/ws#fragment'),
        ]:
            server = {'address': 'example.com:47485', field: value}
            with self.subTest(field=field, value=value), patch.object(PROXY, 'urlopen', return_value=response({
                'oltitle': 'https://gtav.2t.hk', 'servers': [server],
            })):
                result = PROXY.online_remote_configuration()
            self.assertEqual(result['source'], 'unavailable')
            self.assertEqual(result['config'], {'oltitle': ''})

    def test_empty_or_missing_lines_never_create_a_local_default(self):
        for fields in ({}, {'servers': []}, {'server': []}):
            with self.subTest(fields=fields), patch.object(PROXY, 'urlopen', return_value=response({
                'oltitle': 'https://gtav.2t.hk', **fields,
            })):
                result = PROXY.online_remote_configuration()
            self.assertEqual(result['config']['servers'], [])
        with patch.object(PROXY, 'urlopen', return_value=response({
            'oltitle': 'https://gtav.2t.hk',
            'servers': [{'address': 'example.com:47485'}] * 33,
        })):
            self.assertEqual(PROXY.online_remote_configuration()['source'], 'unavailable')


if __name__ == '__main__':
    unittest.main()
