"""Exercise the development HTTP language contract without real game data."""
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
import serve_local


class LanguageHttpTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='gta-language-http-')
        self.base = Path(self.temporary.name)
        self.game = self.base / 'player-game'
        self.game.mkdir()
        # Even a same-named resource cannot become the launcher's dictionary.
        (self.game / 'i18n.js').write_bytes(b'original-player-resource')
        self.before = self.inventory()

    def inventory(self):
        return {str(path.relative_to(self.game)): hashlib.sha256(path.read_bytes()).hexdigest()
                for path in self.game.rglob('*') if path.is_file()}

    def tearDown(self):
        self.assertEqual(self.inventory(), self.before, 'Language endpoints must not change player resources')
        self.temporary.cleanup()

    @contextmanager
    def server(self, language):
        server = serve_local.LocalServer(('127.0.0.1', 0), language=language,
            game_root=self.game, runtime_root=self.base / 'runtime', log_file=self.base / 'logs/browser.log')
        thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': 0.01}, daemon=True)
        with patch.object(serve_local.Handler, 'log_message', lambda *_args: None):
            thread.start()
            try:
                yield server, 'http://127.0.0.1:' + str(server.server_port)
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_system_and_explicit_preferences_have_uncached_get_and_head(self):
        for preference, resolved in [('system', None), ('zh-CN', 'zh-CN'), ('en', 'en')]:
            with self.subTest(preference=preference), self.server(preference) as (_server, base):
                with urlopen(base + '/api/language') as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers.get_content_type(), 'application/json')
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    self.assertEqual(response.headers['Cross-Origin-Opener-Policy'], 'same-origin')
                    self.assertEqual(json.load(response), {'preference': preference, 'resolved': resolved, 'revision': 1})
                with urlopen(Request(base + '/api/language', method='HEAD')) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                    self.assertGreater(int(response.headers['Content-Length']), 0)
                    self.assertEqual(response.read(), b'')

    def test_web_clients_cannot_change_configuration_by_post_or_query(self):
        with self.server('zh-CN') as (server, base):
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(base + '/api/language?language=en', method='POST',
                    data=b'{"preference":"en","resolved":"en","revision":99}',
                    headers={'Content-Type': 'application/json'}))
            with error.exception as response:
                self.assertEqual(response.code, 405)
                self.assertEqual(response.headers['Allow'], 'GET, HEAD')
                self.assertEqual(response.headers['Cache-Control'], 'no-store')
            self.assertEqual(server.language, 'zh-CN')
            with urlopen(base + '/api/language?language=en') as response:
                self.assertEqual(json.load(response)['resolved'], 'zh-CN')

    def test_static_dictionary_is_launcher_owned_and_available_without_game_files(self):
        with self.server('en') as (_server, base):
            with urlopen(base + '/i18n.js') as response:
                self.assertEqual(response.headers.get_content_type(), 'text/javascript')
                self.assertEqual(response.headers['Cache-Control'], 'no-cache')
                self.assertEqual(response.read(), (ROOT / 'client/i18n.js').read_bytes())
            with urlopen(base + '/play/') as response:
                self.assertIn(b"from '/i18n.js'", response.read())

    def test_invalid_preference_fails_before_binding_http_port(self):
        with self.assertRaisesRegex(ValueError, 'Unsupported language preference'):
            serve_local.LocalServer(('127.0.0.1', 0), language='fr', game_root=self.game,
                runtime_root=self.base / 'runtime', log_file=self.base / 'logs/browser.log')


if __name__ == '__main__':
    unittest.main()
