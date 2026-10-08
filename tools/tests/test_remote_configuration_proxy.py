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


if __name__ == '__main__':
    unittest.main()
