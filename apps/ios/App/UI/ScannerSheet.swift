import SwiftUI
import VisionKit

/// Reads a QR code with the camera: the code of a pairing card, or of an invite. Codes that
/// are something else are passed over.
struct ScannerSheet<Found>: View {
    /// What to point the camera at.
    let hint: LocalizedStringKey
    /// What to do where there is no camera.
    let otherwise: LocalizedStringKey
    /// What a code's text is, when it is one this sheet looks for.
    let read: (String) -> Found?
    let onFound: (Found) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if DataScannerViewController.isSupported, DataScannerViewController.isAvailable {
                    Scanner(read: read, onFound: onFound)
                        .ignoresSafeArea()
                        .overlay(alignment: .bottom) {
                            Text(hint)
                                .font(.callout)
                                .multilineTextAlignment(.center)
                                .padding(.horizontal, 18)
                                .padding(.vertical, 12)
                                .glassEffect()
                                .padding(24)
                        }
                } else {
                    ContentUnavailableView(
                        "The camera isn’t available",
                        systemImage: "camera",
                        description: Text(otherwise)
                    )
                }
            }
            .navigationTitle("Scan the code")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                }
            }
        }
    }
}

private struct Scanner<Found>: UIViewControllerRepresentable {
    let read: (String) -> Found?
    let onFound: (Found) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(read: read, onFound: onFound) }

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(
            recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true
        )
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

    static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
        scanner.stopScanning()
    }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let read: (String) -> Found?
        let onFound: (Found) -> Void
        private var found = false

        init(read: @escaping (String) -> Found?, onFound: @escaping (Found) -> Void) {
            self.read = read
            self.onFound = onFound
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !found else { return }
            for case .barcode(let barcode) in addedItems {
                if let text = barcode.payloadStringValue, let link = read(text) {
                    found = true
                    onFound(link)
                    return
                }
            }
        }
    }
}
