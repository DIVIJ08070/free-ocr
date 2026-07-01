import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:http/http.dart' as http;
import 'package:image_picker/image_picker.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// Backend. Override in-app via ⚙ (stored on device).
///  • Phone + Mac same Wi-Fi → http://192.168.29.186:3001
///  • Deployed server        → https://your-domain
const String kDefaultBackend = 'http://192.168.29.186:3001';

// ── palette ──
const _bg = Color(0xFF0A0A0F);
const _surface = Color(0xFF14141C);
const _surface2 = Color(0xFF1B1B26);
const _green = Color(0xFF19C37D);
const _violet = Color(0xFF7C5CFF);
const _line = Color(0x14FFFFFF);
const _line2 = Color(0x24FFFFFF);
const _ink = Color(0xFFF1F2F5);
const _muted = Color(0xFF8A90A0);
const _aiGrad = LinearGradient(colors: [_green, _violet]);

void main() => runApp(const CardSenseApp());

class CardSenseApp extends StatelessWidget {
  const CardSenseApp({super.key});
  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'CardSense',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.dark,
        scaffoldBackgroundColor: _bg,
        colorScheme: const ColorScheme.dark(primary: _green, surface: _surface),
        splashColor: _green.withValues(alpha: 0.08),
        highlightColor: Colors.transparent,
      ),
      home: const ScanScreen(),
    );
  }
}

Route<T> _fadeRoute<T>(Widget page) => PageRouteBuilder<T>(
      transitionDuration: const Duration(milliseconds: 340),
      reverseTransitionDuration: const Duration(milliseconds: 240),
      pageBuilder: (_, __, ___) => page,
      transitionsBuilder: (_, a, __, child) => FadeTransition(
        opacity: a,
        child: SlideTransition(
          position: Tween(begin: const Offset(0, 0.04), end: Offset.zero)
              .animate(CurvedAnimation(parent: a, curve: Curves.easeOutCubic)),
          child: child,
        ),
      ),
    );

// ─────────────────────────────── backend config ───────────────────────────────
Future<String> getBackend() async =>
    (await SharedPreferences.getInstance()).getString('backend') ?? kDefaultBackend;
Future<void> setBackend(String url) async =>
    (await SharedPreferences.getInstance()).setString('backend', url.trim());

// ──────────────────────────────────── model ───────────────────────────────────
class CardData {
  final Map<String, dynamic> j;
  CardData(this.j);
  String s(String k) => (j[k] ?? '').toString();
  String get confidence => s('confidence').isEmpty ? 'medium' : s('confidence');
  bool get aiUsed => j['ai_used'] == true;
  String get provider => s('provider');
  String get model => s('model');
  String get rawText => s('raw_text');
  String get engineLabel {
    if (!aiUsed) return 'Local OCR (no AI)';
    const names = {'gemini': 'Gemini', 'groq': 'Groq', 'openai': 'OpenAI', 'anthropic': 'Claude', 'xai': 'Grok'};
    final pv = names[provider] ?? (provider.isEmpty ? 'AI' : provider);
    final vision = s('source') == 'ai-vision' ? ' vision' : '';
    return '$pv$vision${model.isEmpty ? '' : ' · $model'}';
  }

  List<MapEntry<String, String>> get extras {
    final e = j['extras'];
    if (e is! List) return [];
    return e
        .whereType<Map>()
        .map((m) => MapEntry('${m['label'] ?? ''}', '${m['value'] ?? ''}'))
        .where((m) => m.value.trim().isNotEmpty)
        .toList();
  }
}

// ───────────────────────────────────── api ────────────────────────────────────
Future<CardData> scanCard(List<XFile> files, {required bool useAi}) async {
  final base = await getBackend();
  final uri = Uri.parse('$base/card?mode=${useAi ? 'auto' : 'local'}');
  final req = http.MultipartRequest('POST', uri);
  for (final f in files) {
    req.files.add(await http.MultipartFile.fromPath('files', f.path));
  }
  final res = await req.send().timeout(const Duration(seconds: 90));
  final body = await res.stream.bytesToString();
  if (res.statusCode != 200) throw 'Server error ${res.statusCode}';
  if (body.isEmpty) throw 'No response (timed out?)';
  final data = jsonDecode(body) as Map<String, dynamic>;
  if (data['error'] != null) throw '${data['error']}';
  return CardData(data);
}

// ─────────────────────────────── animated aurora ──────────────────────────────
class _Aurora extends StatefulWidget {
  const _Aurora();
  @override
  State<_Aurora> createState() => _AuroraState();
}

class _AuroraState extends State<_Aurora> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(seconds: 16))..repeat(reverse: true);
  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Widget _blob(Color c, double size) => Container(
        width: size,
        height: size,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: RadialGradient(colors: [c, c.withValues(alpha: 0)]),
        ),
      );

  @override
  Widget build(BuildContext context) {
    return IgnorePointer(
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, __) {
          final t = Curves.easeInOut.transform(_c.value);
          return Stack(children: [
            Positioned(top: -130 + 50 * t, left: -90 - 30 * t, child: _blob(_green.withValues(alpha: 0.20), 340)),
            Positioned(top: 40 + 80 * (1 - t), right: -110 + 40 * t, child: _blob(_violet.withValues(alpha: 0.18), 320)),
          ]);
        },
      ),
    );
  }
}

// ───────────────────────────────── scan screen ────────────────────────────────
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key});
  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _picker = ImagePicker();
  final List<XFile> _files = [];
  bool _useAi = true;
  bool _loading = false;
  static const _max = 4;
  static const _labels = ['Front', 'Back', 'III', 'IV'];

  Future<void> _camera() async {
    final x = await _picker.pickImage(source: ImageSource.camera, maxWidth: 2048, maxHeight: 2048, imageQuality: 92);
    if (x != null && _files.length < _max) setState(() => _files.add(x));
  }

  Future<void> _gallery() async {
    final xs = await _picker.pickMultiImage(maxWidth: 2048, maxHeight: 2048, imageQuality: 92);
    setState(() {
      for (final x in xs) {
        if (_files.length < _max) _files.add(x);
      }
    });
  }

  Future<void> _scan() async {
    if (_files.isEmpty) return;
    setState(() => _loading = true);
    try {
      final data = await scanCard(_files, useAi: _useAi);
      if (!mounted) return;
      await Navigator.push(context, _fadeRoute(ReviewScreen(data: data)));
    } catch (e) {
      if (!mounted) return;
      _snack('Scan failed: $e', err: true);
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _snack(String m, {bool err = false}) => ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        behavior: SnackBarBehavior.floating,
        backgroundColor: err ? const Color(0xFF3A1D24) : _surface2,
        content: Text(m, style: const TextStyle(color: _ink)),
      ));

  Future<void> _settings() async {
    final ctl = TextEditingController(text: await getBackend());
    if (!mounted) return;
    await showDialog(
      context: context,
      builder: (dctx) => AlertDialog(
        backgroundColor: _surface,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
        title: const Text('Backend URL', style: TextStyle(color: _ink, fontSize: 17)),
        content: TextField(
          controller: ctl,
          style: const TextStyle(color: _ink),
          decoration: _inputDeco('http://192.168.x.x:3001'),
        ),
        actions: [
          TextButton(onPressed: () => Navigator.pop(dctx), child: const Text('Cancel', style: TextStyle(color: _muted))),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: _green, foregroundColor: Colors.black),
            onPressed: () async {
              final nav = Navigator.of(dctx);
              await setBackend(ctl.text);
              nav.pop();
            },
            child: const Text('Save'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Stack(
        children: [
          const Positioned.fill(child: _Aurora()),
          SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 20, 20, 40),
              children: [
                _header(),
                const SizedBox(height: 26),
                const Text('Scan a card',
                    style: TextStyle(color: _ink, fontSize: 28, fontWeight: FontWeight.w800, letterSpacing: -0.5)),
                const SizedBox(height: 6),
                const Text('Point, shoot, and the details fill in themselves.',
                    style: TextStyle(color: _muted, fontSize: 14.5)),
                const SizedBox(height: 24),
                _uploadCard(),
                const SizedBox(height: 14),
                Row(children: [
                  Expanded(child: _softBtn(Icons.photo_camera_rounded, 'Camera', _camera)),
                  const SizedBox(width: 12),
                  Expanded(child: _softBtn(Icons.photo_library_rounded, 'Gallery', _gallery)),
                ]),
                const SizedBox(height: 14),
                _aiToggle(),
                const SizedBox(height: 20),
                _scanButton(),
              ],
            ),
          ),
          if (_loading)
            Positioned.fill(
              child: _Analyzing(ai: _useAi, imagePath: _files.isNotEmpty ? _files.first.path : null),
            ),
        ],
      ),
    );
  }

  Widget _header() => Row(children: [
        GestureDetector(
          onLongPress: _settings, // hidden: long-press the logo to change the backend URL
          child: Container(
            width: 46,
            height: 46,
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(14),
              gradient: _aiGrad,
              boxShadow: [BoxShadow(color: _green.withValues(alpha: 0.35), blurRadius: 18, offset: const Offset(0, 6))],
            ),
            child: const Icon(Icons.auto_awesome, color: Colors.white, size: 24),
          ),
        ),
        const SizedBox(width: 13),
        const Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text('CardSense', style: TextStyle(color: _ink, fontSize: 20, fontWeight: FontWeight.w800)),
            Text('AI Business Card Scanner', style: TextStyle(color: _muted, fontSize: 12.5)),
          ]),
        ),
      ]);

  Widget _uploadCard() {
    return _glass(
      padding: const EdgeInsets.all(16),
      child: _files.isEmpty
          ? InkWell(
              onTap: _gallery,
              borderRadius: BorderRadius.circular(16),
              child: Container(
                height: 168,
                decoration: BoxDecoration(
                  borderRadius: BorderRadius.circular(16),
                  border: Border.all(color: _line2, width: 1.4),
                ),
                child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                  Container(
                    width: 56,
                    height: 56,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      gradient: LinearGradient(colors: [_green.withValues(alpha: 0.25), _violet.withValues(alpha: 0.25)]),
                    ),
                    child: const Icon(Icons.add_a_photo_rounded, color: _green, size: 26),
                  ),
                  const SizedBox(height: 12),
                  const Text('Add front & back of the card',
                      style: TextStyle(color: _ink, fontWeight: FontWeight.w600, fontSize: 14.5)),
                  const SizedBox(height: 4),
                  const Text('Camera or gallery · up to 4', style: TextStyle(color: _muted, fontSize: 12)),
                ]),
              ),
            )
          : Wrap(spacing: 12, runSpacing: 12, children: [
              for (int i = 0; i < _files.length; i++) _thumb(i),
            ]),
    );
  }

  Widget _thumb(int i) => Stack(children: [
        ClipRRect(
          borderRadius: BorderRadius.circular(12),
          child: Image.file(File(_files[i].path), width: 100, height: 68, fit: BoxFit.cover),
        ),
        Positioned(
          left: 6,
          bottom: 4,
          child: Text(i < _labels.length ? _labels[i] : '${i + 1}',
              style: const TextStyle(color: Colors.white, fontSize: 10, fontWeight: FontWeight.bold, shadows: [
                Shadow(color: Colors.black, blurRadius: 3),
              ])),
        ),
        Positioned(
          top: 3,
          right: 3,
          child: GestureDetector(
            onTap: () => setState(() => _files.removeAt(i)),
            child: Container(
              width: 20,
              height: 20,
              decoration: const BoxDecoration(color: Colors.black87, shape: BoxShape.circle),
              child: const Icon(Icons.close_rounded, color: Colors.white, size: 13),
            ),
          ),
        ),
      ]);

  Widget _aiToggle() => _glass(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
        child: Row(children: [
          const Icon(Icons.bolt_rounded, color: _green, size: 20),
          const SizedBox(width: 12),
          const Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text('AI assist', style: TextStyle(color: _ink, fontSize: 14.5, fontWeight: FontWeight.w600)),
              Text('Gemini vision · best accuracy', style: TextStyle(color: _muted, fontSize: 11.5)),
            ]),
          ),
          Switch(
            value: _useAi,
            onChanged: (v) => setState(() => _useAi = v),
            activeThumbColor: Colors.white,
            activeTrackColor: _green,
            inactiveThumbColor: _muted,
            inactiveTrackColor: _surface2,
          ),
        ]),
      );

  Widget _scanButton() {
    final on = _files.isNotEmpty && !_loading;
    return Opacity(
      opacity: on ? 1 : 0.5,
      child: GestureDetector(
        onTap: on ? _scan : null,
        child: Container(
          height: 56,
          decoration: BoxDecoration(
            gradient: _aiGrad,
            borderRadius: BorderRadius.circular(16),
            boxShadow: on
                ? [BoxShadow(color: _green.withValues(alpha: 0.4), blurRadius: 24, offset: const Offset(0, 8))]
                : null,
          ),
          child: const Center(
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(Icons.auto_awesome, color: Colors.white, size: 20),
              SizedBox(width: 10),
              Text('Scan card', style: TextStyle(color: Colors.white, fontSize: 16.5, fontWeight: FontWeight.w700)),
            ]),
          ),
        ),
      ),
    );
  }
}

// ─────────────────────────────── analyzing state ──────────────────────────────
class _Analyzing extends StatefulWidget {
  final bool ai;
  final String? imagePath;
  const _Analyzing({required this.ai, this.imagePath});
  @override
  State<_Analyzing> createState() => _AnalyzingState();
}

class _AnalyzingState extends State<_Analyzing> with SingleTickerProviderStateMixin {
  late final AnimationController _c =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 1000))..repeat(reverse: true);
  Timer? _t;
  int _step = 0; // which status line
  int _len = 0; // chars shown of it
  bool _erasing = false;
  late final List<String> _steps = widget.ai
      ? const ['Scanning the card', 'Reading the text', 'Extracting details', 'Almost done']
      : const ['Scanning the card', 'Detecting the text', 'Extracting details', 'Almost done'];

  @override
  void initState() {
    super.initState();
    _type();
  }

  // typewriter: type a line out, hold, erase it, then the next line.
  void _type() {
    final word = _steps[_step];
    int delay;
    if (!_erasing) {
      if (_len < word.length) {
        _len++;
        delay = 45;
      } else {
        _erasing = true;
        delay = 850; // hold when fully typed
      }
    } else {
      if (_len > 0) {
        _len--;
        delay = 24;
      } else {
        _erasing = false;
        _step = (_step + 1) % _steps.length;
        delay = 200;
      }
    }
    if (mounted) setState(() {});
    _t = Timer(Duration(milliseconds: delay), () {
      if (mounted) _type();
    });
  }

  @override
  void dispose() {
    _t?.cancel();
    _c.dispose();
    super.dispose();
  }

  // viewfinder corner bracket
  Widget _corner(Alignment a, bool top, bool left) => Align(
        alignment: a,
        child: Container(
          margin: const EdgeInsets.all(9),
          width: 20,
          height: 20,
          decoration: BoxDecoration(
            border: Border(
              top: top ? const BorderSide(color: _green, width: 2.5) : BorderSide.none,
              bottom: !top ? const BorderSide(color: _green, width: 2.5) : BorderSide.none,
              left: left ? const BorderSide(color: _green, width: 2.5) : BorderSide.none,
              right: !left ? const BorderSide(color: _green, width: 2.5) : BorderSide.none,
            ),
          ),
        ),
      );

  @override
  Widget build(BuildContext context) {
    const w = 280.0, h = 180.0;
    return BackdropFilter(
      filter: ui.ImageFilter.blur(sigmaX: 20, sigmaY: 20),
      child: Container(
      color: Colors.black.withValues(alpha: 0.55),
      child: Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          ClipRRect(
            borderRadius: BorderRadius.circular(16),
            child: SizedBox(
              width: w,
              height: h,
              child: Stack(fit: StackFit.expand, children: [
                if (widget.imagePath != null)
                  Image.file(File(widget.imagePath!), fit: BoxFit.cover)
                else
                  Container(color: _surface2, child: const Icon(Icons.credit_card_rounded, color: _muted, size: 44)),
                Container(color: Colors.black.withValues(alpha: 0.30)),
                // sweeping scan line + glow band
                AnimatedBuilder(
                  animation: _c,
                  builder: (_, __) {
                    final y = h * Curves.easeInOut.transform(_c.value);
                    return Stack(children: [
                      Positioned(
                        top: y - 44,
                        left: 0,
                        right: 0,
                        height: 88,
                        child: Container(
                          decoration: BoxDecoration(
                            gradient: LinearGradient(
                              begin: Alignment.topCenter,
                              end: Alignment.bottomCenter,
                              colors: [_green.withValues(alpha: 0), _green.withValues(alpha: 0.30), _green.withValues(alpha: 0)],
                            ),
                          ),
                        ),
                      ),
                      Positioned(
                        top: y,
                        left: 6,
                        right: 6,
                        child: Container(
                          height: 2.5,
                          decoration: BoxDecoration(
                            color: _green,
                            borderRadius: BorderRadius.circular(2),
                            boxShadow: [BoxShadow(color: _green.withValues(alpha: 0.9), blurRadius: 12, spreadRadius: 1)],
                          ),
                        ),
                      ),
                    ]);
                  },
                ),
                _corner(Alignment.topLeft, true, true),
                _corner(Alignment.topRight, true, false),
                _corner(Alignment.bottomLeft, false, true),
                _corner(Alignment.bottomRight, false, false),
              ]),
            ),
          ),
          const SizedBox(height: 24),
          SizedBox(
            width: 262,
            child: Row(
              children: [
                const SizedBox(width: 16, height: 16, child: CircularProgressIndicator(strokeWidth: 2, color: _green)),
                const SizedBox(width: 10),
                Flexible(
                  child: Text(
                    _steps[_step].substring(0, _len),
                    maxLines: 1,
                    overflow: TextOverflow.clip,
                    style: const TextStyle(color: _ink, fontSize: 15.5, fontWeight: FontWeight.w500),
                  ),
                ),
                AnimatedBuilder(
                  animation: _c,
                  builder: (_, __) => Opacity(
                    opacity: _c.value < 0.5 ? 1.0 : 0.2,
                    child: const Text('▌', style: TextStyle(color: _green, fontSize: 15, fontWeight: FontWeight.w700)),
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
          Text(widget.ai ? '✨ Gemini vision' : '🆓 Local OCR', style: const TextStyle(color: _muted, fontSize: 12)),
        ]),
      ),
      ),
    );
  }
}

// ──────────────────────────────── review screen ───────────────────────────────
const _fields = [
  ['first_name', 'First Name'],
  ['last_name', 'Last Name'],
  ['company', 'Company'],
  ['designation', 'Designation / Job Title'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['whatsapp', 'WhatsApp'],
  ['website', 'Website'],
  ['linkedin', 'LinkedIn'],
  ['instagram', 'Instagram'],
  ['youtube', 'YouTube'],
  ['facebook', 'Facebook'],
  ['address', 'Address / Location'],
];

class ReviewScreen extends StatefulWidget {
  final CardData data;
  const ReviewScreen({super.key, required this.data});
  @override
  State<ReviewScreen> createState() => _ReviewScreenState();
}

class _ReviewScreenState extends State<ReviewScreen> with SingleTickerProviderStateMixin {
  late final Map<String, TextEditingController> _ctl;
  bool _showAll = false;
  late final AnimationController _anim =
      AnimationController(vsync: this, duration: const Duration(milliseconds: 900))..forward();

  @override
  void initState() {
    super.initState();
    _ctl = {for (final f in _fields) f[0]: TextEditingController(text: widget.data.s(f[0]))};
  }

  @override
  void dispose() {
    _anim.dispose();
    for (final c in _ctl.values) {
      c.dispose();
    }
    super.dispose();
  }

  Widget _stagger(int index, Widget child) {
    final start = (index * 0.045).clamp(0.0, 0.7);
    final anim = CurvedAnimation(parent: _anim, curve: Interval(start, (start + 0.5).clamp(0.0, 1.0), curve: Curves.easeOutCubic));
    return AnimatedBuilder(
      animation: anim,
      builder: (_, c) => Opacity(opacity: anim.value, child: Transform.translate(offset: Offset(0, 18 * (1 - anim.value)), child: c)),
      child: child,
    );
  }

  String _vcard() {
    String g(String k) => (_ctl[k]?.text ?? '').trim();
    final fn = [g('first_name'), g('last_name')].where((e) => e.isNotEmpty).join(' ');
    final L = <String>['BEGIN:VCARD', 'VERSION:3.0'];
    if (fn.isNotEmpty) {
      L.add('FN:$fn');
      L.add('N:${g('last_name')};${g('first_name')};;;');
    }
    if (g('company').isNotEmpty) L.add('ORG:${g('company')}');
    if (g('designation').isNotEmpty) L.add('TITLE:${g('designation')}');
    if (g('email').isNotEmpty) L.add('EMAIL;TYPE=WORK:${g('email')}');
    if (g('phone').isNotEmpty) L.add('TEL;TYPE=WORK,VOICE:${g('phone')}');
    if (g('whatsapp').isNotEmpty) L.add('TEL;TYPE=CELL:${g('whatsapp')}');
    if (g('website').isNotEmpty) L.add('URL:${g('website')}');
    if (g('address').isNotEmpty) L.add('ADR;TYPE=WORK:;;${g('address').replaceAll(',', r'\,')};;;;');
    for (final k in ['linkedin', 'instagram', 'youtube', 'facebook']) {
      if (g(k).isNotEmpty) L.add('X-SOCIALPROFILE;TYPE=$k:${g(k)}');
    }
    for (final e in widget.data.extras) {
      L.add('NOTE:${e.key}: ${e.value}');
    }
    L.add('END:VCARD');
    return L.join('\r\n');
  }

  Map<String, String> _collect() => {for (final f in _fields) f[0]: _ctl[f[0]]!.text.trim()};

  void _copy(String text, String what) {
    Clipboard.setData(ClipboardData(text: text));
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
      behavior: SnackBarBehavior.floating,
      backgroundColor: _surface2,
      content: Text('$what copied', style: const TextStyle(color: _ink)),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final c = widget.data.confidence;
    final cColor = c == 'high' ? _green : (c == 'medium' ? const Color(0xFFE7B85A) : const Color(0xFFF0857A));
    bool hasVal(List<String> f) => (_ctl[f[0]]?.text ?? '').trim().isNotEmpty;
    final visible = _showAll ? _fields : _fields.where(hasVal).toList();
    final emptyCount = _fields.where((f) => !hasVal(f)).length;
    return Scaffold(
      body: Stack(children: [
        const Positioned.fill(child: _Aurora()),
        SafeArea(
          child: Column(children: [
            _topBar(),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(18, 6, 18, 40),
                children: [
                  _stagger(
                    0,
                    Row(children: [
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                        decoration: BoxDecoration(
                          color: cColor.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(999),
                          border: Border.all(color: cColor.withValues(alpha: 0.45)),
                        ),
                        child: Row(mainAxisSize: MainAxisSize.min, children: [
                          Container(width: 7, height: 7, decoration: BoxDecoration(color: cColor, shape: BoxShape.circle)),
                          const SizedBox(width: 7),
                          Text('${c[0].toUpperCase()}${c.substring(1)} confidence',
                              style: TextStyle(color: cColor, fontWeight: FontWeight.w600, fontSize: 12.5)),
                        ]),
                      ),
                      const Spacer(),
                    ]),
                  ),
                  const SizedBox(height: 10),
                  _stagger(
                    1,
                    Row(children: [
                      Icon(widget.data.aiUsed ? Icons.auto_awesome : Icons.memory_rounded,
                          size: 15, color: widget.data.aiUsed ? _green : _muted),
                      const SizedBox(width: 6),
                      Flexible(
                        child: Text(widget.data.engineLabel,
                            style: TextStyle(
                                color: widget.data.aiUsed ? _green : _muted,
                                fontSize: 12.5,
                                fontWeight: FontWeight.w600),
                            overflow: TextOverflow.ellipsis),
                      ),
                    ]),
                  ),
                  const SizedBox(height: 18),
                  for (int i = 0; i < visible.length; i++) _stagger(i + 2, _field(visible[i][0], visible[i][1])),
                  if (visible.isEmpty)
                    const Padding(
                      padding: EdgeInsets.symmetric(vertical: 18),
                      child: Center(
                        child: Text('No fields detected — try a clearer photo.',
                            style: TextStyle(color: _muted, fontStyle: FontStyle.italic, fontSize: 13.5)),
                      ),
                    ),
                  if (emptyCount > 0) _stagger(visible.length + 2, _showAllToggle(emptyCount)),
                  if (widget.data.extras.isNotEmpty) _stagger(visible.length + 3, _extrasCard()),
                  const SizedBox(height: 18),
                  _stagger(visible.length + 4, _gradButton(Icons.person_add_alt_1_rounded, 'Copy vCard', () => _copy(_vcard(), 'vCard'))),
                  const SizedBox(height: 10),
                  _stagger(visible.length + 5, _outlineButton(Icons.data_object_rounded, 'Copy JSON',
                      () => _copy(const JsonEncoder.withIndent('  ').convert(_collect()), 'JSON'))),
                  const SizedBox(height: 14),
                  _stagger(visible.length + 6, _rawOcr()),
                ],
              ),
            ),
          ]),
        ),
      ]),
    );
  }

  Widget _topBar() => Padding(
        padding: const EdgeInsets.fromLTRB(8, 8, 16, 8),
        child: Row(children: [
          _iconBtn(Icons.arrow_back_rounded, () => Navigator.pop(context)),
          const SizedBox(width: 6),
          const Text('Review details', style: TextStyle(color: _ink, fontSize: 18, fontWeight: FontWeight.w700)),
        ]),
      );

  Widget _showAllToggle(int emptyCount) => Padding(
        padding: const EdgeInsets.only(top: 2, bottom: 4),
        child: Center(
          child: TextButton.icon(
            onPressed: () => setState(() => _showAll = !_showAll),
            icon: Icon(_showAll ? Icons.visibility_off_rounded : Icons.add_rounded, color: _green, size: 18),
            label: Text(_showAll ? 'Hide empty fields' : 'Show all fields ($emptyCount empty)',
                style: const TextStyle(color: _green, fontWeight: FontWeight.w600, fontSize: 13.5)),
          ),
        ),
      );

  Widget _field(String key, String label) => Padding(
        padding: const EdgeInsets.only(bottom: 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 6),
            child: Text(label, style: const TextStyle(color: _muted, fontSize: 12.5, fontWeight: FontWeight.w500)),
          ),
          TextField(
            controller: _ctl[key],
            minLines: 1,
            maxLines: key == 'address' ? 3 : 1,
            style: const TextStyle(color: _ink, fontSize: 15),
            decoration: _inputDeco(''),
          ),
        ]),
      );

  Widget _extrasCard() => Container(
        margin: const EdgeInsets.only(top: 6, bottom: 6),
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: _green.withValues(alpha: 0.06),
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: _green.withValues(alpha: 0.25)),
        ),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Row(children: [
            Icon(Icons.info_outline_rounded, color: _green, size: 16),
            SizedBox(width: 7),
            Text('Other details', style: TextStyle(color: _green, fontWeight: FontWeight.w700, fontSize: 13)),
          ]),
          const SizedBox(height: 10),
          for (final e in widget.data.extras)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: RichText(
                text: TextSpan(children: [
                  TextSpan(text: '${e.key}:  ', style: const TextStyle(color: _muted, fontSize: 13.5)),
                  TextSpan(text: e.value, style: const TextStyle(color: _ink, fontSize: 13.5)),
                ]),
              ),
            ),
        ]),
      );

  Widget _rawOcr() => Theme(
        data: Theme.of(context).copyWith(dividerColor: Colors.transparent),
        child: _glass(
          padding: EdgeInsets.zero,
          child: ExpansionTile(
            shape: const Border(),
            collapsedShape: const Border(),
            tilePadding: const EdgeInsets.symmetric(horizontal: 16),
            title: const Text('Raw OCR text', style: TextStyle(color: _muted, fontSize: 13)),
            collapsedIconColor: _muted,
            iconColor: _muted,
            childrenPadding: const EdgeInsets.fromLTRB(14, 0, 14, 14),
            children: [
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(color: const Color(0xFF08080C), borderRadius: BorderRadius.circular(10)),
                child: Text(widget.data.rawText.isEmpty ? '(none)' : widget.data.rawText,
                    style: const TextStyle(color: Color(0xFFB8BEC9), fontSize: 12, height: 1.5)),
              ),
            ],
          ),
        ),
      );

  Widget _gradButton(IconData ic, String label, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          height: 52,
          decoration: BoxDecoration(
            gradient: _aiGrad,
            borderRadius: BorderRadius.circular(14),
            boxShadow: [BoxShadow(color: _green.withValues(alpha: 0.3), blurRadius: 18, offset: const Offset(0, 6))],
          ),
          child: Center(
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(ic, color: Colors.white, size: 20),
              const SizedBox(width: 9),
              Text(label, style: const TextStyle(color: Colors.white, fontSize: 15.5, fontWeight: FontWeight.w700)),
            ]),
          ),
        ),
      );

  Widget _outlineButton(IconData ic, String label, VoidCallback onTap) => GestureDetector(
        onTap: onTap,
        child: Container(
          height: 52,
          decoration: BoxDecoration(
            color: _surface,
            borderRadius: BorderRadius.circular(14),
            border: Border.all(color: _line2),
          ),
          child: Center(
            child: Row(mainAxisSize: MainAxisSize.min, children: [
              Icon(ic, color: _ink, size: 19),
              const SizedBox(width: 9),
              Text(label, style: const TextStyle(color: _ink, fontSize: 15, fontWeight: FontWeight.w600)),
            ]),
          ),
        ),
      );
}

// ──────────────────────────────── shared bits ─────────────────────────────────
Widget _glass({required Widget child, EdgeInsets padding = const EdgeInsets.all(16)}) => Container(
      padding: padding,
      decoration: BoxDecoration(
        color: _surface.withValues(alpha: 0.85),
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: _line),
      ),
      child: child,
    );

InputDecoration _inputDeco(String hint) => InputDecoration(
      isDense: true,
      hintText: hint,
      hintStyle: const TextStyle(color: _muted),
      filled: true,
      fillColor: _surface2,
      contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 13),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: _line)),
      focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: _green, width: 1.4)),
    );

Widget _softBtn(IconData ic, String label, VoidCallback onTap) => GestureDetector(
      onTap: onTap,
      child: Container(
        height: 50,
        decoration: BoxDecoration(color: _surface, borderRadius: BorderRadius.circular(13), border: Border.all(color: _line)),
        child: Center(
          child: Row(mainAxisSize: MainAxisSize.min, children: [
            Icon(ic, color: _ink, size: 19),
            const SizedBox(width: 8),
            Text(label, style: const TextStyle(color: _ink, fontSize: 14.5, fontWeight: FontWeight.w600)),
          ]),
        ),
      ),
    );

Widget _iconBtn(IconData ic, VoidCallback onTap) => GestureDetector(
      onTap: onTap,
      child: Container(
        width: 42,
        height: 42,
        decoration: BoxDecoration(color: _surface, borderRadius: BorderRadius.circular(12), border: Border.all(color: _line)),
        child: Icon(ic, color: _muted, size: 20),
      ),
    );
