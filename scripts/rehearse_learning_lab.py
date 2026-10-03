"""Explicit local EVM/browser-wallet rehearsal; never attaches to existing nodes."""
import argparse
from http.server import ThreadingHTTPServer
import json
import os
import socket
import subprocess
import threading
import time
from learning_lab import CHAIN, LearningLab, LocalRpc
from serve_learning_lab import handler
from rehearse_learning_update import ROOT, run


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--execute-local', action='store_true', required=True)
    parser.add_argument('--anvil', default='anvil')
    parser.add_argument('--cast', default='cast')
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    for port in (18548, 18766):
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', port))
    model = json.loads(run(['cargo', 'run', '--offline', '--quiet', '-p', 'flurbo-core', '--example', 'parlay_model']))
    child = subprocess.Popen([args.anvil, '--host', '127.0.0.1', '--port', '18548', '--chain-id', str(CHAIN),
        '--accounts', '3', '--silent'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    server = None
    try:
        rpc = LocalRpc()
        for _ in range(100):
            if child.poll() is not None:
                raise RuntimeError('Owned Anvil exited')
            try:
                rpc('web3_clientVersion')
                break
            except OSError:
                time.sleep(.1)
        else:
            raise RuntimeError('Node did not start')
        lab = LearningLab(args.cast, model, rpc)
        server = ThreadingHTTPServer(('127.0.0.1', 18766), handler(lab))
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        print(run([args.node, 'apps/dashboard/learning-live-test.mjs', '--execute-local']), flush=True)
    finally:
        if server:
            server.shutdown()
            server.server_close()
            thread.join()
        child.terminate()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=5)


if __name__ == '__main__':
    main()
