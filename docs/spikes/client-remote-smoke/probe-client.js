// The probe's client half.
//
// Deliberately written in the module-loader wrapper by hand: the first-party
// client bundles are generated, and one of the things this smoke checks is that
// a *hand-written* third-party client bundle is served and executed the same
// way. Anything resembling a build step here would hide that.
window.__ModuleLoader__.load({
	id: '@zhaolianghz/dsh-connection-probe',
	factory: require => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		function report(text) {
			var node = document.getElementById('ts-probe')
			if (node === null) {
				node = document.createElement('pre')
				node.id = 'ts-probe'
				;(document.body || document.documentElement).appendChild(node)
			}
			node.textContent += text + '\n'
		}
		report('PROBE: module loaded')

		// The question under test. `connection` is provided by
		// `@deepseek-ai/dsh-client-connection`; `typert` and the module graph are
		// not involved in this decision, so this is the whole assertion.
		exports.inject = ['connection']
		exports.apply = async ctx => {
			report('PROBE: apply() ran, so `connection` was injected')
			try {
				const connection = ctx.get('connection')
				report('PROBE: connection.rpc is ' + typeof (connection && connection.rpc))
				// A first-party service, chosen because it exists in every web
				// profile. The session id is deliberately absent, so the expected
				// answer is a business failure *inside* a successful envelope —
				// which is exactly what proves the request reached the host and
				// was validated there rather than being answered locally.
				const result = await connection.rpc.call(
					'/api',
					'messageFeedback/list',
					{ args: { request: { sessionId: 'probe-session-that-does-not-exist' } } },
					undefined,
				)
				report('PROBE: rpc resolved -> ' + JSON.stringify(result).slice(0, 300))

				// The second call is the one this harness exists for now: it is our own
				// host face, reached with the exact envelope our browser bundle sends
				// (`{ args: { request } }`), against a session that was never recorded —
				// so an empty page is the right answer, and getting it proves the adapter
				// is mounted rather than merely listed in the boot graph.
				const ours = await connection.rpc.call(
					'/api',
					'turnscope/listTurns',
					{ args: { request: { apiVersion: PLACEHOLDER_API_VERSION, sessionId: 'probe-session', limit: 30 } } },
					undefined,
				)
				report('PROBE: turnscope/listTurns -> ' + JSON.stringify(ours).slice(0, 300))
			} catch (error) {
				report('PROBE: rpc threw -> ' + String(error && error.message ? error.message : error))
			}
		}
		return module.exports
	},
})
