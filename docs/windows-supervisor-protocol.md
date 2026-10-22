# Windows supervisor protocol

`src/process-tree-supervisor-cs.ts` is the canonical C# source for the Windows
Job Object supervisor. The TS host continues to use its named-pipe channel and
inherited stdio. Its launch API and named-pipe wire behavior have not changed.

An additional mode serves hosts such as PHP that cannot select Windows pipes.
It supplies real anonymous pipes to the provider and forwards their bytes over
three TCP streams. The provider is created suspended, assigned to the same Job
Object with kill-on-close and no breakaway, and then resumed. Every descendant,
including a detached grandchild, belongs to that job.

## Selecting the mode

The host binds a listener to IPv4 loopback before launching the supervisor,
then sets these variables in the supervisor's child environment:

```text
PRISM_ACP_TREE_CHANNEL=tcp://127.0.0.1:<port>
PRISM_ACP_TREE_TOKEN=<64 lowercase hexadecimal characters from 32 random bytes>
```

Only the literal IPv4 loopback address and a decimal port in 1–65535 are
accepted; there is no DNS resolution, URL path, user info, or arbitrary remote
destination. A named-pipe channel continues to select the existing mode. The
supervisor removes both variables before creating the provider.

No TS driver opts into TCP by default. This is a supervisor protocol for an
explicit host implementation, not a new transport option on `launchProvider`.

## Control handshake

All control/handshake messages are ASCII lines, terminated by LF (CRLF is also
accepted). `S` is the supervisor, `H` the host:

```text
S -> H: hello <token>
H -> S: auth <token>
H -> S: spawn <base64 application> <base64 Windows command line> <base64 cwd>
```

The host must validate the hello token before accepting this connection as
control. The supervisor compares the ACK with its expected token before
accepting a spawn specification. Comparisons check length and accumulate all
character differences; no early mismatch prefix is accepted.

Each field uses canonical base64 containing nonempty, valid UTF-8 without NUL.
Application and cwd must be absolute Windows paths; the command line is limited
to 32,766 UTF-16 code units, leaving room for Windows' terminating NUL. The
host resolves the executable and quotes argv without a shell, as the TS host
already does. A `.cmd` requires npm-shim resolution by the host; the supervisor
never starts a shell to interpret it.

Authentication lines are limited to 128 bytes before LF. Spawn and subsequent
control lines are limited to 262,144 bytes before LF, including an optional CR.
Bare CR, other ASCII control bytes, non-ASCII bytes, extra/missing fields,
invalid base64, and malformed UTF-8 are refused. Errors do not include the
received content.

Connection establishment, authentication, and the initial spawn line each have
a five-second deadline. A deadline bounds the whole authentication/line read,
so sending one byte at a time does not extend it. After launch the control
channel may remain idle indefinitely; once a partial command starts, it has
five seconds to finish. These bounds apply to the additional TCP mode.

The host must also bound and time out incoming unauthenticated connections,
validate the token on every stream, and refuse duplicate roles. A TCP
connection alone is not proof that its peer is the supervisor.

## Stdio handshake and raw bytes

Before creating the provider, the supervisor connects three more streams to
the same listener, in fd order. Each has its own bounded authentication:

```text
S -> H: stdio <token> 0
H -> S: auth <token> 0
S -> H: stdio <token> 1
H -> S: auth <token> 1
S -> H: stdio <token> 2
H -> S: auth <token> 2
```

After each ACK's LF the stream carries raw binary bytes, with no further
framing: host-to-provider stdin on fd 0, provider-to-host stdout on fd 1, and
provider-to-host stderr on fd 2. The first stdin bytes may share a TCP packet
with the ACK; a host or supervisor must retain bytes after the header. There
is no ordering promise between stdout and stderr, only within each stream.

The supervisor supplies genuine inheritable pipe handles to `CreateProcessW`.
Its parent pipe ends and TCP sockets are not inheritable. Each pump uses a
fixed 8 KiB byte buffer and synchronous reads/writes on its own background
thread. Output backpressure blocks that pump without accumulating an unbounded
application queue or blocking the control thread. Every chunk is flushed;
small stdin messages must not remain buffered until EOF.

The host must drain stdout and stderr concurrently and handle input write
backpressure. Closing the sending half of fd 0 closes the provider's stdin;
it does not request a tree kill. Stdio is carried on these sockets rather than
the supervisor process's own stdin/stdout/stderr.

## Completion and failure

After all authentication and assignment to the Job Object:

```text
S -> H: started <pid>       OR failed <win32 error>
H -> S: kill               OR control EOF
S -> H: exited <code>      (only if the provider ended on its own)
S -> H: failed control     (malformed post-launch command)
S -> H: failed io          (pump failure or output drain deadline)
S -> H: empty <active>
```

`kill`, control EOF, an invalid post-launch command, or a pump error ends the
job. An idle input stream or input EOF does not. If the provider exits on its
own, remaining descendants are still terminated. The supervisor asks the job
for its active count; `empty 0` means the job reported no surviving processes.
The existing job-count query's unknown sentinel remains `4294967295`.

After ending the tree, the supervisor gives stdout and stderr a shared
five-second drain window before reporting `empty` and exiting. A peer that
keeps its output streams unread can exhaust this window: it receives `failed
io`, and remaining byte delivery is not promised. A process count is not an
I/O success verdict. The host should wait for output EOF as well as control
completion when it needs all final output.

Pre-spawn authentication/framing refusal closes the connections and exits 125,
without starting a provider. Job/setup and spawn failures use 126/127 and a
numeric failure report when available. Any failure after process creation
terminates the suspended process if not yet assigned, or closes/terminates its
job after assignment. No path falls back to an uncontained provider.

## Source and executable integrity

The source stays canonical here so other language ports can vendor it and
enforce byte equality in CI. `prepareProcessTree` still builds once per install
using .NET Framework's `csc.exe`; its directory key is the first 16 hex digits
of the C# source SHA-256. Changing this source selects a new cache directory.
The built executable's separate SHA-256 is recorded and checked before every
TS launch. That check and rebuild/refusal behavior are unchanged. A port must
retain equivalent compilation and per-launch verification; selecting TCP is
not permission to bypass those checks.

`test/process-tree-tcp.test.ts` drives the compiled source through a Node test
host and real processes on Windows. It checks detached-tree stop, control EOF,
hard host death, authentication/timeouts, malformed/oversized control input,
and exact binary stdio under paused output readers. Existing named-pipe,
driver, models, compilation and tamper tests run unchanged. Linux CI skips the
Windows TCP tests explicitly; it does not establish Windows behavior.
