import Foundation
import Contacts

@MainActor
final class ContactsTools {
    private let store = CNContactStore()

    enum ContactsError: LocalizedError {
        case denied
        var errorDescription: String? { "Contacts permission denied" }
    }

    func search(query: String, limit: Int = 10) throws -> [[String: Any]] {
        guard CNContactStore.authorizationStatus(for: .contacts) == .authorized else {
            throw ContactsError.denied
        }
        let keys: [CNKeyDescriptor] = [
            CNContactGivenNameKey, CNContactFamilyNameKey,
            CNContactEmailAddressesKey, CNContactPhoneNumbersKey,
            CNContactOrganizationNameKey, CNContactNicknameKey,
        ] as [CNKeyDescriptor]

        let predicate = CNContact.predicateForContacts(matchingName: query)
        let matches = (try? store.unifiedContacts(matching: predicate, keysToFetch: keys)) ?? []
        return matches.prefix(limit).map { c in
            [
                "name": [c.givenName, c.familyName].filter { !$0.isEmpty }.joined(separator: " "),
                "nickname": c.nickname,
                "organization": c.organizationName,
                "emails": c.emailAddresses.map { String($0.value) },
                "phones": c.phoneNumbers.map { $0.value.stringValue },
            ]
        }
    }
}
