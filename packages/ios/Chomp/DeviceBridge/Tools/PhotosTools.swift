import Foundation
import Photos
import UIKit

@MainActor
final class PhotosTools {
    enum PhotosError: LocalizedError {
        case denied
        case decodeFailed
        case saveFailed(String)
        case notFound
        case readFailed(String)
        var errorDescription: String? {
            switch self {
            case .denied: return "Photo library permission denied"
            case .decodeFailed: return "base64 image data could not be decoded"
            case .saveFailed(let s): return "Photo save failed: \(s)"
            case .notFound: return "No photo with that id, or it is outside the photos shared with Chomp"
            case .readFailed(let s): return "Photo read failed: \(s)"
            }
        }
    }

    func listRecent(limit: Int) throws -> [[String: Any]] {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw PhotosError.denied
        }
        let fetch = PHFetchOptions()
        fetch.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        fetch.fetchLimit = max(1, min(limit, 50))
        let assets = PHAsset.fetchAssets(with: .image, options: fetch)
        var results: [[String: Any]] = []
        assets.enumerateObjects { asset, _, _ in
            results.append([
                "id": asset.localIdentifier,
                "createdAt": asset.creationDate.map { ISO8601DateFormatter().string(from: $0) } ?? "",
                "width": asset.pixelWidth,
                "height": asset.pixelHeight,
                "isFavorite": asset.isFavorite,
                "isScreenshot": asset.mediaSubtypes.contains(.photoScreenshot),
            ])
        }
        return results
    }

    /// The size to ask for: fits inside `maxDimension`, and never upscales.
    nonisolated static func fittedSize(width: Int, height: Int, maxDimension: Int) -> CGSize {
        let scale = min(1, Double(maxDimension) / Double(max(width, height, 1)))
        return CGSize(width: (Double(width) * scale).rounded(), height: (Double(height) * scale).rounded())
    }

    /// One photo as JPEG. The API turns `imageBase64` into an image the agent can see.
    func read(id: String, maxDimension: Int) async throws -> ToolResult {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw PhotosError.denied
        }
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw PhotosError.notFound
        }
        let size = Self.fittedSize(width: asset.pixelWidth, height: asset.pixelHeight, maxDimension: maxDimension)
        let options = PHImageRequestOptions()
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = true // Optimised storage keeps originals in iCloud.
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            PHImageManager.default().requestImage(for: asset, targetSize: size, contentMode: .aspectFit, options: options) { image, info in
                if info?[PHImageResultIsDegradedKey] as? Bool == true { return }
                if let image {
                    cont.resume(returning: image)
                } else {
                    let error = info?[PHImageErrorKey] as? Error
                    cont.resume(throwing: PhotosError.readFailed(error?.localizedDescription ?? "No image returned"))
                }
            }
        }
        guard let jpeg = image.jpegData(compressionQuality: 0.8) else {
            throw PhotosError.readFailed("JPEG encoding failed")
        }
        return [
            "id": id,
            "createdAt": asset.creationDate.map { ISO8601DateFormatter().string(from: $0) } ?? "",
            "width": Int(image.size.width * image.scale),
            "height": Int(image.size.height * image.scale),
            "mimeType": "image/jpeg",
            "imageBase64": jpeg.base64EncodedString(),
        ]
    }

    func saveImage(base64: String) async throws -> String {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        guard status == .authorized || status == .limited else {
            throw PhotosError.denied
        }
        guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters),
              let image = UIImage(data: data) else {
            throw PhotosError.decodeFailed
        }
        return try await withCheckedThrowingContinuation { cont in
            var placeholder: String = ""
            PHPhotoLibrary.shared().performChanges {
                let req = PHAssetChangeRequest.creationRequestForAsset(from: image)
                placeholder = req.placeholderForCreatedAsset?.localIdentifier ?? ""
            } completionHandler: { ok, err in
                if ok {
                    cont.resume(returning: placeholder)
                } else {
                    cont.resume(throwing: PhotosError.saveFailed(err?.localizedDescription ?? "Unknown"))
                }
            }
        }
    }
}
