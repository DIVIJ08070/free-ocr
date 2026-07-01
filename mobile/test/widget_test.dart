import 'package:flutter_test/flutter_test.dart';

import 'package:cardsense/main.dart';

void main() {
  testWidgets('app boots to the scan screen', (WidgetTester tester) async {
    await tester.pumpWidget(const CardSenseApp());
    expect(find.text('CardSense'), findsOneWidget);
    expect(find.text('Scan card'), findsOneWidget);
  });
}
